import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AppMe,
  type AppMember,
  type DevelopmentMode,
  type SandboxMember,
  type SandboxRole,
  RemoteAppSession,
  loadDevelopmentConfig,
  mintDevelopmentSession,
  proxyRemoteAppRequest,
  remoteJson,
} from "./development.js";
import {
  type NotificationData,
  type NotificationRecord,
  notificationInspectorHtml,
} from "./notification-inspector.js";

const MAX_BODY_BYTES = 51 * 1024 * 1024;
export const SANDBOX_APP_QUERY = "__maypop_app";

/** Remove the private iframe marker before application routing starts. */
export function sandboxMarkerCleanupScript(): string {
  const query = JSON.stringify(SANDBOX_APP_QUERY);
  return `const u=new URL(location.href);if(u.searchParams.has(${query})){u.searchParams.delete(${query});history.replaceState(null,"",u.pathname+u.search+u.hash)}`;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type KvEntry = {
  value: JsonValue;
  author: string;
  updatedAt: string;
};

type KvData = {
  schemaVersion: 1;
  version: number;
  entries: Record<string, KvEntry>;
  clients: Record<string, number>;
  clientVersions: Record<string, number>;
};

type DriveFile = {
  id: string;
  cid: string;
  name: string;
  mimeType: string | null;
  size: number;
  uploadedBy: string;
  createdAt: string;
};

type DriveData = { schemaVersion: 1; files: DriveFile[] };
type SandboxIdentity = { schemaVersion: 1; appId: string; viewerId: string };

type MockMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  result?: JsonValue;
};

type MockMcpServer = {
  id: string;
  name: string;
  url: string;
  account: string | null;
  tools: MockMcpTool[];
};

type MockMcpData = { schemaVersion: 1; servers: MockMcpServer[] };

type KvPolicyAction = "read" | "create" | "update" | "delete" | "sync";
type KvPolicyRole = "guest" | "user" | "admin" | "owner";
type KvPolicyOwner =
  | { source: "entryAuthor" }
  | { source: "jsonPointer"; pointer: string };
type KvPolicyRule = {
  actions: KvPolicyAction[];
  roles: KvPolicyRole[];
  key: string;
  owner?: KvPolicyOwner;
};
type KvPolicyManifest = {
  schemaVersion: 1;
  mode?:
    | "shared_group_data"
    | "owner_private"
    | "group_read_admin_write"
    | "governed"
    | "advanced";
  rules?: KvPolicyRule[];
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

class JsonStore<T> {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private current: T,
  ) {}

  get value(): T {
    return this.current;
  }

  update(mutator: (value: T) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const next = structuredClone(this.current);
      mutator(next);
      await writeJsonAtomic(this.path, next);
      this.current = next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** Options shared by local Maypop sandbox bindings. */
export interface MaypopSandboxOptions {
  /** Storage directory, relative to the project root. Defaults to `.maypop`. */
  dataDirectory?: string;
  /** Viewer name exposed through `maypop.user`. Defaults to `Developer`. */
  username?: string;
  /** Replicache pull fallback for hosts whose development proxy buffers SSE. */
  kvPullIntervalMs?: number;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(
        `Maypop sandbox data at ${path} is not valid JSON. Fix or remove that file before restarting.`,
        { cause: error },
      );
    }
    throw new Error(`Could not read Maypop sandbox data at ${path}`, {
      cause: error,
    });
  }
}

function fixtureId(appId: string, member: SandboxMember, index: number): string {
  if (member.id) return member.id;
  const hex = createHash("sha256")
    .update(`${appId}\0${index}\0${member.username}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ]
    .map((part) => part.join(""))
    .join("-");
}

function sandboxScopes(role: SandboxRole, anonymous: boolean): Set<string> {
  const scopes = new Set([
    "identity:read",
    "group:read",
    "kv:read",
    "drive:read",
  ]);
  if (!anonymous && role !== "reader") {
    scopes.add("kv:write");
    scopes.add("drive:write");
  }
  return scopes;
}

function validateMockMcp(path: string, value: unknown): MockMcpData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Maypop MCP fixtures at ${path}: expected an object`);
  }
  const data = value as Partial<MockMcpData>;
  if (data.schemaVersion !== 1 || !Array.isArray(data.servers)) {
    throw new Error(
      `Invalid Maypop MCP fixtures at ${path}: expected schemaVersion 1 and a servers array`,
    );
  }
  for (const [serverIndex, server] of data.servers.entries()) {
    if (
      typeof server?.id !== "string" ||
      !server.id ||
      typeof server.name !== "string" ||
      !server.name ||
      typeof server.url !== "string" ||
      !server.url ||
      !Array.isArray(server.tools)
    ) {
      throw new Error(
        `Invalid Maypop MCP fixtures at ${path}: server ${serverIndex + 1} is incomplete`,
      );
    }
    for (const [toolIndex, tool] of server.tools.entries()) {
      if (
        typeof tool?.name !== "string" ||
        !tool.name ||
        typeof tool.description !== "string" ||
        typeof tool.inputSchema !== "object" ||
        tool.inputSchema === null ||
        Array.isArray(tool.inputSchema)
      ) {
        throw new Error(
          `Invalid Maypop MCP fixtures at ${path}: tool ${toolIndex + 1} on server ${server.id} is incomplete`,
        );
      }
    }
  }
  return data as MockMcpData;
}

const KV_ACTIONS: KvPolicyAction[] = [
  "read",
  "create",
  "update",
  "delete",
  "sync",
];
const KV_ROLES: KvPolicyRole[] = ["guest", "user", "admin", "owner"];

function presetKvRules(
  mode: NonNullable<KvPolicyManifest["mode"]>,
): KvPolicyRule[] {
  const memberRoles: KvPolicyRole[] = ["user", "admin", "owner"];
  const adminRoles: KvPolicyRole[] = ["admin", "owner"];
  const read: KvPolicyAction[] = ["read", "sync"];
  const write: KvPolicyAction[] = ["create", "update", "delete"];
  const guestRead: KvPolicyRule = {
    actions: read,
    roles: ["guest"],
    key: "**",
  };
  if (mode === "shared_group_data") {
    return [
      { actions: KV_ACTIONS, roles: memberRoles, key: "**" },
      guestRead,
    ];
  }
  if (mode === "owner_private") {
    return [
      {
        actions: KV_ACTIONS,
        roles: memberRoles,
        key: "private/{memberId}/**",
      },
    ];
  }
  if (mode === "group_read_admin_write" || mode === "governed") {
    return [
      { actions: read, roles: memberRoles, key: "**" },
      { actions: write, roles: adminRoles, key: "**" },
      guestRead,
    ];
  }
  return [];
}

function validateKvPolicy(path: string, value: unknown): KvPolicyRule[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Maypop KV policy at ${path}: expected an object`);
  }
  const manifest = value as KvPolicyManifest;
  const modes = [
    "shared_group_data",
    "owner_private",
    "group_read_admin_write",
    "governed",
    "advanced",
  ];
  if (
    manifest.schemaVersion !== 1 ||
    (manifest.mode != null && !modes.includes(manifest.mode)) ||
    (manifest.rules != null && !Array.isArray(manifest.rules))
  ) {
    throw new Error(`Invalid Maypop KV policy at ${path}`);
  }
  const explicit = manifest.rules ?? [];
  if (manifest.mode && manifest.mode !== "advanced") {
    if (explicit.length > 0) {
      throw new Error(
        `Invalid Maypop KV policy at ${path}: preset policies cannot declare rules`,
      );
    }
    return presetKvRules(manifest.mode);
  }
  if (explicit.length > 128) {
    throw new Error(`Invalid Maypop KV policy at ${path}: too many rules`);
  }
  for (const [index, rule] of explicit.entries()) {
    const segments = typeof rule?.key === "string" ? rule.key.split("/") : [];
    if (
      !Array.isArray(rule?.actions) ||
      rule.actions.length === 0 ||
      rule.actions.some((action) => !KV_ACTIONS.includes(action)) ||
      !Array.isArray(rule.roles) ||
      rule.roles.length === 0 ||
      rule.roles.some((policyRole) => !KV_ROLES.includes(policyRole)) ||
      typeof rule.key !== "string" ||
      !rule.key ||
      Buffer.byteLength(rule.key) > 1_024 ||
      segments.some(
        (segment, segmentIndex) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          (segment === "**" && segmentIndex !== segments.length - 1) ||
          (segment !== "*" &&
            segment !== "**" &&
            segment !== "{memberId}" &&
            (segment.includes("{") ||
              segment.includes("}") ||
              [...segment].some((character) =>
                /[\u0000-\u001f\u007f-\u009f]/.test(character),
              )))
      )
    ) {
      throw new Error(
        `Invalid Maypop KV policy at ${path}: invalid rule ${index + 1}`,
      );
    }
    if (
      rule.owner != null &&
      (typeof rule.owner !== "object" ||
        !["entryAuthor", "jsonPointer"].includes(rule.owner.source) ||
        (rule.owner.source === "jsonPointer" &&
          (typeof rule.owner.pointer !== "string" ||
            !rule.owner.pointer.startsWith("/"))))
    ) {
      throw new Error(
        `Invalid Maypop KV policy at ${path}: invalid owner in rule ${index + 1}`,
      );
    }
  }
  return explicit;
}

function policyRole(role: SandboxRole): KvPolicyRole {
  return { reader: "guest", writer: "user", editor: "admin", admin: "owner" }[
    role
  ] as KvPolicyRole;
}

function keyMatches(pattern: string, key: string, memberId: string): boolean {
  const expected = pattern.split("/");
  const actual = key.split("/");
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index]!;
    if (segment === "**") return true;
    const value = actual[index];
    if (value == null) return false;
    if (segment === "*") continue;
    if (segment === "{memberId}") {
      if (value !== memberId) return false;
      continue;
    }
    if (segment !== value) return false;
  }
  return actual.length === expected.length;
}

function jsonPointer(value: JsonValue, pointer: string): unknown {
  let current: unknown = value;
  for (const encoded of pointer.split("/").slice(1)) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function ownerMatches(
  owner: KvPolicyOwner | undefined,
  action: KvPolicyAction,
  viewerId: string,
  current: KvEntry | undefined,
  proposed: KvEntry | undefined,
): boolean {
  if (!owner) return true;
  const recordMatches = (record: KvEntry | undefined): boolean => {
    if (!record) return false;
    return owner.source === "entryAuthor"
      ? record.author === viewerId
      : jsonPointer(record.value, owner.pointer) === viewerId;
  };
  if (action === "create") return recordMatches(proposed);
  if (action === "update") {
    return recordMatches(current) && recordMatches(proposed);
  }
  return recordMatches(current);
}

function kvPolicyAllows(
  rules: KvPolicyRule[] | undefined,
  action: KvPolicyAction,
  key: string,
  viewerId: string,
  role: SandboxRole,
  current?: KvEntry,
  proposed?: KvEntry,
): boolean {
  if (!rules) return true;
  const principal = policyRole(role);
  return rules.some(
    (rule) =>
      rule.actions.includes(action) &&
      rule.roles.includes(principal) &&
      keyMatches(rule.key, key, viewerId) &&
      ownerMatches(rule.owner, action, viewerId, current, proposed),
  );
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function loadIdentity(dataDirectory: string): Promise<SandboxIdentity> {
  const path = join(dataDirectory, "config.json");
  const existing = await readJson<Partial<SandboxIdentity> | null>(path, null);
  if (existing?.appId && existing.viewerId) {
    const identity: SandboxIdentity = {
      schemaVersion: 1,
      appId: existing.appId,
      viewerId: existing.viewerId,
    };
    if (existing.schemaVersion !== 1) await writeJsonAtomic(path, identity);
    return identity;
  }
  const identity: SandboxIdentity = {
    schemaVersion: 1,
    appId: randomUUID(),
    viewerId: randomUUID(),
  };
  await writeJsonAtomic(path, identity);
  return identity;
}

function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sendEmpty(response: ServerResponse, status = 204): void {
  response.writeHead(status);
  response.end();
}

/** Serialize a sandbox runtime error through a Node response. */
export function sendMaypopSandboxError(
  response: ServerResponse,
  error: unknown,
): void {
  const httpError =
    error instanceof HttpError
      ? error
      : new HttpError(
          500,
          error instanceof Error ? error.message : String(error),
        );
  sendJson(
    response,
    {
      error: httpError.message,
      ...(httpError.code ? { code: httpError.code } : {}),
    },
    httpError.status,
  );
}

function requireToken(request: IncomingMessage, url: URL, token: string): void {
  const bearer = request.headers.authorization === `Bearer ${token}`;
  const eventSource = url.searchParams.get("token") === token;
  if (!bearer && !eventSource)
    throw new HttpError(401, "invalid sandbox token");
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  try {
    return JSON.parse((await readBody(request)).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid JSON body");
  }
}

function validateDriveName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    Buffer.byteLength(name) > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(name) ||
    name.includes("\\") ||
    name
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new HttpError(400, "invalid file name");
  }
}

function validateCid(cid: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(cid)) throw new HttpError(404, "file not found");
}

function sandboxHtml(
  identity: SandboxIdentity,
  token: string,
  scopes: string,
  signInRequired: boolean,
  mode: DevelopmentMode,
  appRequestToken: string,
  kvPullIntervalMs: number | undefined,
): string {
  const config = JSON.stringify({
    appId: identity.appId,
    appRequestToken,
    kvPullIntervalMs,
    mode,
    token,
    scopes,
    signInRequired,
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Maypop sandbox</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; background: #111; }
      body { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      iframe { width: 100%; height: 100%; border: 0; background: white; }
      #badge {
        position: fixed; z-index: 2; right: 12px; bottom: 12px;
        padding: 6px 9px; border: 1px solid rgb(255 255 255 / 18%);
        border-radius: 999px; color: rgb(255 255 255 / 72%);
        background: rgb(10 10 10 / 78%); backdrop-filter: blur(10px);
        font-size: 11px; text-decoration: none;
      }
      dialog {
        width: min(520px, calc(100vw - 32px)); border: 1px solid rgb(255 255 255 / 18%);
        border-radius: 16px; color: #f5f5f5; background: #181818; box-shadow: 0 24px 80px rgb(0 0 0 / 55%);
      }
      dialog::backdrop { background: rgb(0 0 0 / 55%); }
      dialog h1 { margin: 0 0 8px; font: 600 18px/1.3 ui-sans-serif, system-ui, sans-serif; }
      dialog p { margin: 0 0 16px; color: #aaa; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
      dialog a { display: block; overflow-wrap: anywhere; color: #fff; }
      dialog menu { display: flex; justify-content: flex-end; gap: 8px; margin: 20px 0 0; padding: 0; }
      dialog button { border: 1px solid #444; border-radius: 9px; padding: 8px 12px; color: #fff; background: #282828; cursor: pointer; }
    </style>
  </head>
  <body>
    <iframe
      id="app"
      title="App"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox allow-downloads"
      allow="autoplay; clipboard-read; clipboard-write; encrypted-media; fullscreen; geolocation; microphone; camera; display-capture; accelerometer; gyroscope; magnetometer"
    ></iframe>
    <a id="badge" href="/_maypop/notifications" target="_blank" rel="noreferrer">Maypop development</a>
    <dialog id="share-card">
      <h1 id="share-title">Share local app</h1>
      <p>This development link opens the same local framework host. It is not a published Maypop link.</p>
      <a id="share-link" target="_blank" rel="noreferrer"></a>
      <menu>
        <button id="share-copy" type="button">Copy link</button>
        <button id="share-close" type="button">Close</button>
      </menu>
    </dialog>
    <script>
      const config = ${config};
      const frame = document.getElementById("app");
      const badge = document.getElementById("badge");
      const shareCard = document.getElementById("share-card");
      const shareTitle = document.getElementById("share-title");
      const shareLink = document.getElementById("share-link");
      let port = null;

      const theme = () => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      const postTheme = () => frame.contentWindow?.postMessage({ type: "maypop:theme", theme: theme() }, location.origin);
      const cleanFrameUrl = () => {
        try {
          const current = new URL(frame.contentWindow.location.href);
          if (current.searchParams.get("${SANDBOX_APP_QUERY}") !== config.appRequestToken) return;
          current.searchParams.delete("${SANDBOX_APP_QUERY}");
          frame.contentWindow.history.replaceState(null, "", current.pathname + current.search + current.hash);
        } catch {}
      };

      const session = () => fetch("/_maypop/session", { cache: "no-store" })
        .then((response) => {
          if (!response.ok) throw new Error("session refresh failed (" + response.status + ")");
          return response.json();
        });

      function connect() {
        if (!frame.contentWindow) return;
        port?.close();
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = (event) => {
          if (event.data?.type === "maypop:ready") badge.textContent = "Maypop " + config.mode + " · connected";
          if (event.data?.type === "maypop:refresh") {
            session()
              .then((session) => port.postMessage({ type: "maypop:token", ...session }))
              .catch(() => port.postMessage({ type: "maypop:revoked" }));
          }
          if (event.data?.type === "maypop:sign-in") {
            fetch("/_maypop/sign-in", { method: "POST" })
              .then((response) => {
                if (!response.ok) throw new Error("local sign-in is not available");
                frame.contentWindow?.location.reload();
              })
              .catch(() => {});
            return;
          }
          if (event.data?.type === "maypop:share" && event.data?.id != null) {
            const path = typeof event.data.path === "string" ? event.data.path : "";
            if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\\\")) {
              port.postMessage({
                type: "maypop:share-error",
                id: event.data.id,
                code: "maypop/invalid-path",
                error: "share path must be site-relative",
              });
              return;
            }
            const link = new URL(path, location.origin).href;
            shareTitle.textContent = typeof event.data.title === "string" && event.data.title.trim()
              ? event.data.title.trim()
              : "Share local app";
            shareLink.href = link;
            shareLink.textContent = link;
            if (!shareCard.open) shareCard.showModal();
            port.postMessage({ type: "maypop:share-done", id: event.data.id });
            return;
          }
          const unsupportedReplies = {
            "maypop:open-app": "maypop:open-app-error",
            "maypop:open-group-settings": "maypop:open-group-settings-error",
          };
          const replyType = unsupportedReplies[event.data?.type];
          if (replyType && event.data?.id != null) {
            port.postMessage({
              type: replyType,
              id: event.data.id,
              code: "maypop/unsupported",
              error: "This capability is not available in the local Maypop sandbox.",
            });
          }
        };
        port.start();
        session().catch(() => config).then((current) => {
          if (port !== channel.port1 || !frame.contentWindow) return;
          frame.contentWindow.postMessage({
            type: "maypop:init",
            context: {
              appId: config.appId,
              apiBase: location.origin,
              kvPullIntervalMs: config.kvPullIntervalMs,
            },
            token: { token: current.token, expiresIn: current.expiresIn ?? 86400, scopes: current.scopes },
            signInRequired: current.signInRequired === true,
          }, location.origin, [channel.port2]);
        });
        postTheme();
      }

      addEventListener("message", (event) => {
        if (event.source === frame.contentWindow && event.data?.type === "maypop:hello") connect();
      });
      frame.addEventListener("load", () => {
        cleanFrameUrl();
        connect();
      });
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", postTheme);
      document.getElementById("share-close").addEventListener("click", () => shareCard.close());
      document.getElementById("share-copy").addEventListener("click", async () => {
        await navigator.clipboard.writeText(shareLink.href);
      });
      const appUrl = new URL(location.href);
      appUrl.searchParams.set("${SANDBOX_APP_QUERY}", config.appRequestToken);
      frame.src = appUrl.pathname + appUrl.search + appUrl.hash;
    </script>
  </body>
</html>`;
}

/** Framework-neutral local Maypop host runtime. */
export interface MaypopSandboxRuntime {
  dataDirectory: string;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void>;
  close(): void;
}

function acquireDataDirectoryLock(dataDirectory: string): () => void {
  const path = join(dataDirectory, ".lock");

  function openLock(): number {
    try {
      return openSync(path, "wx");
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(owner)) {
        try {
          process.kill(owner, 0);
        } catch (processError) {
          if ((processError as { code?: string }).code === "ESRCH") {
            unlinkSync(path);
            return openLock();
          }
        }
      }
      throw new Error(
        `Maypop sandbox data at ${dataDirectory} is already in use by another development server.`,
        { cause: error },
      );
    }
  }

  const descriptor = openLock();
  writeFileSync(descriptor, `${process.pid}\n`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  };
}

type ByteRange = { start: number; end: number };

function parseByteRange(header: string, size: number): ByteRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return undefined;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
      return undefined;
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function isSandboxDocumentRequest(
  method: string,
  request: IncomingMessage,
  url: URL,
  token: string,
): boolean {
  if (
    method !== "GET" ||
    url.searchParams.get(SANDBOX_APP_QUERY) === token ||
    request.headers["sec-fetch-dest"] === "iframe"
  ) {
    return false;
  }
  return request.headers.accept?.includes("text/html") ?? false;
}

/** A standalone localhost server used by bindings without middleware hooks. */
export interface MaypopSandboxServer {
  origin: string;
  close(): Promise<void>;
}

/** Serve the shared sandbox runtime on a private ephemeral localhost port. */
export async function createMaypopSandboxServer(
  root: string,
  options: MaypopSandboxOptions = {},
): Promise<MaypopSandboxServer> {
  const runtime = await createMaypopSandboxRuntime(root, options);
  const server = createServer((request, response) => {
    void runtime
      .handle(request, response, () => {
        response.writeHead(404);
        response.end();
      })
      .catch((error) => sendMaypopSandboxError(response, error));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    runtime.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    runtime.close();
    server.close();
    throw new Error("Maypop sandbox could not determine its localhost port.");
  }

  server.unref();
  let closed = false;
  const closeRuntime = () => runtime.close();
  process.once("exit", closeRuntime);

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      process.off("exit", closeRuntime);
      runtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** Create the reusable Node HTTP host used by Maypop development bindings. */
export async function createMaypopSandboxRuntime(
  root: string,
  options: MaypopSandboxOptions = {},
): Promise<MaypopSandboxRuntime> {
  const configuredDirectory = options.dataDirectory ?? ".maypop";
  const dataDirectory = isAbsolute(configuredDirectory)
    ? configuredDirectory
    : resolve(root, configuredDirectory);
  await mkdir(dataDirectory, { recursive: true });
  const releaseLock = acquireDataDirectoryLock(dataDirectory);
  try {
    const development = await loadDevelopmentConfig(dataDirectory);
    const remoteSession =
      development.mode === "sandbox"
        ? undefined
        : new RemoteAppSession(
            await mintDevelopmentSession(root, development.profile),
          );
    const remoteMe = remoteSession
      ? await remoteJson<AppMe>(remoteSession, "/me")
      : undefined;
    if (remoteSession && remoteMe) {
      const target = `@${remoteMe.username} · profile ${remoteSession.profile} · ${remoteSession.apiUrl} · app ${remoteSession.appId}`;
      if (development.mode === "connected") {
        console.warn(
          `[maypop] connected development: ${target}. App data and enabled capabilities are real; notifications are ${development.notifications}.`,
        );
      } else {
        console.info(
          `[maypop] hybrid development: ${target}. KV and Drive stay local; authenticated capabilities can consume real allowance.`,
        );
      }
    }
    const usesLocalData = development.mode !== "connected";
    const driveDirectory = join(dataDirectory, "drive");
    const driveFilesDirectory = join(driveDirectory, "files");
    const pendingDirectory = join(driveDirectory, "pending");
    if (usesLocalData) {
      await mkdir(driveFilesDirectory, { recursive: true });
      await rm(pendingDirectory, { recursive: true, force: true });
      await mkdir(pendingDirectory, { recursive: true });
    }

    const localIdentity = remoteSession
      ? undefined
      : await loadIdentity(dataDirectory);
    const identity: SandboxIdentity = remoteSession
      ? { schemaVersion: 1, appId: remoteSession.appId, viewerId: remoteMe!.id }
      : localIdentity!;
    const token = randomBytes(32).toString("base64url");
    const appRequestToken = randomBytes(18).toString("base64url");
    let sandboxSignedIn = development.viewer?.anonymous !== true;
    const mockMcpPath = join(dataDirectory, "mcp.json");
    const emptyMockMcp: MockMcpData = { schemaVersion: 1, servers: [] };
    const mockMcp =
      development.mode === "connected"
        ? emptyMockMcp
        : validateMockMcp(
            mockMcpPath,
            await readJson<unknown>(mockMcpPath, emptyMockMcp),
          );
    if (
      development.mode === "hybrid" &&
      development.remoteCapabilities.includes("mcp") &&
      mockMcp.servers.length > 0
    ) {
      throw new Error(
        "Hybrid MCP cannot use both real app integrations and .maypop/mcp.json fixtures. Remove the fixture or remove `mcp` from remoteCapabilities.",
      );
    }
    const kvPolicyPath = resolve(root, ".maypop/kv-policy.json");
    const rawKvPolicy = development.strictStorage
      ? await readJson<unknown | null>(kvPolicyPath, null)
      : null;
    const kvPolicyRules =
      rawKvPolicy == null ? undefined : validateKvPolicy(kvPolicyPath, rawKvPolicy);

    function activeSandboxViewer(): {
      username: string;
      role: SandboxRole;
      avatarUrl: string | null;
      anonymous: boolean;
      signInRequired: boolean;
    } {
      const configured = development.viewer;
      if (!configured) {
        return {
          username: options.username ?? "Developer",
          role: "admin",
          avatarUrl: null,
          anonymous: false,
          signInRequired: false,
        };
      }
      if (configured.anonymous && sandboxSignedIn) {
        return {
          username: configured.signedInUsername,
          role: configured.signedInRole,
          avatarUrl: configured.avatarUrl,
          anonymous: false,
          signInRequired: false,
        };
      }
      return {
        username: configured.username,
        role: configured.role,
        avatarUrl: configured.avatarUrl,
        anonymous: configured.anonymous,
        signInRequired:
          configured.anonymous && configured.signInGrantsWrite,
      };
    }

    function localDataRole(): SandboxRole {
      if (development.mode === "sandbox") return activeSandboxViewer().role;
      return (["reader", "writer", "editor", "admin"] as const).includes(
        remoteMe?.role as SandboxRole,
      )
        ? (remoteMe!.role as SandboxRole)
        : "reader";
    }

    function developmentScopes(): string {
      const remoteScopeSet = new Set(
        remoteSession?.scopes.split(/\s+/).filter(Boolean),
      );
      const scopeSet =
        development.mode === "connected"
          ? remoteScopeSet
          : development.mode === "sandbox"
            ? sandboxScopes(
                activeSandboxViewer().role,
                activeSandboxViewer().anonymous,
              )
            : sandboxScopes("admin", false);
      if (development.mode === "hybrid") {
        if (
          development.remoteCapabilities.includes("ai") &&
          remoteScopeSet.has("ai:use")
        ) {
          scopeSet.add("ai:use");
        }
        if (
          (development.remoteCapabilities.includes("members") ||
            development.remoteCapabilities.includes("multiplayer")) &&
          remoteScopeSet.has("group:read")
        ) {
          scopeSet.add("group:read");
        }
        if (development.remoteCapabilities.includes("multiplayer")) {
          for (const scope of ["mp:list", "mp:create", "mp:join"]) {
            if (remoteScopeSet.has(scope)) scopeSet.add(scope);
          }
        }
        if (
          development.remoteCapabilities.includes("mcp") &&
          remoteScopeSet.has("mcp:use")
        ) {
          scopeSet.add("mcp:use");
        }
      }
      if (
        development.notifications === "inspect" &&
        (development.mode !== "sandbox" ||
          (!activeSandboxViewer().anonymous &&
            activeSandboxViewer().role !== "reader"))
      ) {
        scopeSet.add("notify:send");
      }
      if (development.notifications === "disabled")
        scopeSet.delete("notify:send");
      if (mockMcp.servers.length > 0) scopeSet.add("mcp:use");
      return [...scopeSet].join(" ");
    }
    const initialScopes = developmentScopes();
    const kvPath = join(dataDirectory, "kv.json");
    const emptyKvData: KvData = {
      schemaVersion: 1,
      version: 0,
      entries: {},
      clients: {},
      clientVersions: {},
    };
    const kvData = usesLocalData
      ? await readJson<Partial<KvData>>(kvPath, emptyKvData)
      : emptyKvData;
    if (kvData.schemaVersion != null && kvData.schemaVersion !== 1) {
      throw new Error(`Unsupported Maypop KV schema version in ${kvPath}.`);
    }
    const migrateKvData = kvData.schemaVersion !== 1 || !kvData.clientVersions;
    kvData.schemaVersion = 1;
    kvData.version ??= 0;
    kvData.entries ??= {};
    kvData.clients ??= {};
    if (!kvData.clientVersions) {
      kvData.version += 1;
      const version = kvData.version;
      kvData.clientVersions = Object.fromEntries(
        Object.keys(kvData.clients).map((clientId) => [clientId, version]),
      );
    }
    if (usesLocalData && migrateKvData) await writeJsonAtomic(kvPath, kvData);
    const kv = new JsonStore(kvPath, kvData as KvData);
    const drivePath = join(driveDirectory, "index.json");
    const emptyDriveData: DriveData = {
      schemaVersion: 1,
      files: [],
    };
    const driveData = usesLocalData
      ? await readJson<Partial<DriveData>>(drivePath, emptyDriveData)
      : emptyDriveData;
    if (driveData.schemaVersion != null && driveData.schemaVersion !== 1) {
      throw new Error(
        `Unsupported Maypop Drive schema version in ${drivePath}.`,
      );
    }
    const migrateDriveData = driveData.schemaVersion !== 1;
    driveData.schemaVersion = 1;
    driveData.files ??= [];
    if (usesLocalData && migrateDriveData)
      await writeJsonAtomic(drivePath, driveData);
    const drive = new JsonStore(drivePath, driveData as DriveData);
    const notificationPath = join(dataDirectory, "notifications.json");
    const notificationData = await readJson<Partial<NotificationData>>(
      notificationPath,
      { schemaVersion: 1, notifications: [] },
    );
    if (
      notificationData.schemaVersion != null &&
      notificationData.schemaVersion !== 1
    ) {
      throw new Error(
        `Unsupported Maypop notification schema version in ${notificationPath}.`,
      );
    }
    notificationData.schemaVersion = 1;
    notificationData.notifications ??= [];
    const notifications = new JsonStore(
      notificationPath,
      notificationData as NotificationData,
    );
    const pending = new Map<
      string,
      { mimeType: string | null; size: number }
    >();
    const pokeClients = new Set<ServerResponse>();
    const remoteControllers = new Set<AbortController>();

    const localMember = (): AppMe => {
      const viewer = activeSandboxViewer();
      return {
        id: identity.viewerId,
        username: viewer.username,
        role: viewer.role,
        avatarUrl: viewer.avatarUrl,
        connected: true,
        isAnonymous: viewer.anonymous,
        scopes: developmentScopes(),
      };
    };

    const localMembers = (): AppMember[] => {
      const { isAnonymous: _isAnonymous, scopes: _scopes, ...viewer } =
        localMember();
      return [
        viewer,
        ...development.members.map((member, index) => ({
          id: fixtureId(identity.appId, member, index),
          username: member.username,
          role: member.role,
          avatarUrl: member.avatarUrl,
          connected: member.connected,
        })),
      ].sort((left, right) => left.username.localeCompare(right.username));
    };

    async function currentViewer(): Promise<AppMe | AppMember> {
      return remoteSession
        ? remoteJson<AppMe>(remoteSession, "/me")
        : localMember();
    }

    async function currentMembers(): Promise<AppMember[]> {
      if (
        remoteSession &&
        (development.mode === "connected" ||
          development.remoteCapabilities.includes("members") ||
          development.remoteCapabilities.includes("multiplayer"))
      ) {
        const result = await remoteJson<{
          members: AppMember[];
          guestCount: number;
        }>(remoteSession, "/members");
        return result.members;
      }
      return localMembers();
    }

    function poke(): void {
      for (const response of pokeClients) response.write("data: poke\n\n");
    }

    function requireDevelopmentScope(scope: string): void {
      if (!developmentScopes().split(/\s+/).includes(scope)) {
        throw new HttpError(403, `missing scope for ${scope}`);
      }
    }

    async function handle(
      request: IncomingMessage,
      response: ServerResponse,
      next: () => void,
    ): Promise<void> {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://maypop.local");

      if (method === "GET" && url.pathname === "/_maypop/notifications") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(notificationInspectorHtml(development.mode));
        return;
      }
      if (method === "GET" && url.pathname === "/_maypop/notifications.json") {
        sendJson(response, notifications.value);
        return;
      }
      if (method === "DELETE" && url.pathname === "/_maypop/notifications") {
        await notifications.update((data) => {
          data.notifications = [];
        });
        sendEmpty(response);
        return;
      }
      if (method === "GET" && url.pathname === "/_maypop/session") {
        if (remoteSession) await remoteSession.currentToken();
        sendJson(response, {
          token,
          expiresIn: 86_400,
          scopes: developmentScopes(),
          signInRequired:
            development.mode === "sandbox" &&
            activeSandboxViewer().signInRequired,
        });
        return;
      }
      if (method === "POST" && url.pathname === "/_maypop/sign-in") {
        if (
          development.mode !== "sandbox" ||
          !activeSandboxViewer().signInRequired
        ) {
          throw new HttpError(409, "local sign-in is not available");
        }
        sandboxSignedIn = true;
        sendJson(response, {
          token,
          expiresIn: 86_400,
          scopes: developmentScopes(),
          signInRequired: false,
        });
        return;
      }

      if (isSandboxDocumentRequest(method, request, url, appRequestToken)) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(
          sandboxHtml(
            identity,
            token,
            initialScopes,
            development.mode === "sandbox" &&
              activeSandboxViewer().signInRequired,
            development.mode,
            appRequestToken,
            options.kvPullIntervalMs,
          ),
        );
        return;
      }

      if (method === "GET" && url.pathname === "/sdk/kv-v1.js") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8",
        });
        createReadStream(
          fileURLToPath(new URL("./kv-v1.js", import.meta.url)),
        ).pipe(response);
        return;
      }

      if (method === "GET" && url.pathname === "/sdk/agent-v1.js") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8",
        });
        createReadStream(
          fileURLToPath(new URL("./agent-v1.js", import.meta.url)),
        ).pipe(response);
        return;
      }

      if (method === "GET" && url.pathname === "/sdk/iroh-v1.js") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8",
        });
        createReadStream(
          fileURLToPath(new URL("./iroh-v1.js", import.meta.url)),
        ).pipe(response);
        return;
      }

      if (method === "GET" && url.pathname === "/sdk/iroh-v1_bg.wasm") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/wasm",
        });
        createReadStream(
          fileURLToPath(new URL("./iroh-v1_bg.wasm", import.meta.url)),
        ).pipe(response);
        return;
      }

      if (method === "GET" && url.pathname === "/_maypop-sw.js") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8",
          "Service-Worker-Allowed": "/",
        });
        createReadStream(
          fileURLToPath(new URL("./app-cache-sw.js", import.meta.url)),
        ).pipe(response);
        return;
      }

      if (method === "POST" && url.pathname.startsWith("/_maypop/upload/")) {
        const cid = decodeURIComponent(
          url.pathname.slice("/_maypop/upload/".length),
        );
        validateCid(cid);
        const contentType = request.headers["content-type"];
        if (!contentType?.startsWith("multipart/form-data")) {
          throw new HttpError(400, "expected multipart upload");
        }
        const form = await new Response(await readBody(request), {
          headers: { "Content-Type": contentType },
        }).formData();
        const file = form.get("file");
        if (!(file instanceof Blob))
          throw new HttpError(400, "missing upload file");
        const bytes = Buffer.from(await file.arrayBuffer());
        await writeFile(join(pendingDirectory, cid), bytes);
        pending.set(cid, { mimeType: file.type || null, size: bytes.length });
        sendEmpty(response);
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/_maypop/drive/")) {
        const cid = decodeURIComponent(
          url.pathname.slice("/_maypop/drive/".length),
        );
        validateCid(cid);
        const file = drive.value.files.find(
          (candidate) => candidate.cid === cid,
        );
        if (!file) throw new HttpError(404, "file not found");
        const headers = {
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Content-Type": file.mimeType ?? "application/octet-stream",
        };
        const requestedRange = request.headers.range;
        if (!requestedRange) {
          response.writeHead(200, { ...headers, "Content-Length": file.size });
          createReadStream(join(driveFilesDirectory, cid)).pipe(response);
          return;
        }
        const range = parseByteRange(requestedRange, file.size);
        if (!range) {
          response.writeHead(416, {
            ...headers,
            "Content-Range": `bytes */${file.size}`,
          });
          response.end();
          return;
        }
        response.writeHead(206, {
          ...headers,
          "Content-Length": range.end - range.start + 1,
          "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`,
        });
        createReadStream(join(driveFilesDirectory, cid), range).pipe(response);
        return;
      }

      if (!url.pathname.startsWith("/app-api/")) {
        next();
        return;
      }
      requireToken(request, url, token);

      if (method === "GET" && url.pathname === "/app-api/me") {
        const viewer = await currentViewer();
        sendJson(response, {
          ...viewer,
          scopes: developmentScopes(),
        });
        return;
      }

      if (url.pathname === "/app-api/notify") {
        if (development.notifications === "disabled") {
          throw new HttpError(403, "notifications are disabled for local development");
        }
        if (development.notifications === "inspect") {
          if (method !== "POST") throw new HttpError(405, "method not allowed");
          requireDevelopmentScope("notify:send");
          const body = await readJsonBody<{
            to?: "all" | string[];
            title?: unknown;
            body?: unknown;
            path?: unknown;
          }>(request);
          if (
            typeof body.title !== "string" ||
            !body.title.trim() ||
            [...body.title.trim()].length > 120
          ) {
            throw new HttpError(400, "invalid title");
          }
          const notificationBody =
            typeof body.body === "string" ? body.body.trim() : undefined;
          if (
            body.body != null &&
            (typeof body.body !== "string" ||
              [...(notificationBody ?? "")].length > 500)
          ) {
            throw new HttpError(400, "invalid body");
          }
          const notificationPath =
            typeof body.path === "string" ? body.path.trim() : undefined;
          if (
            body.path != null &&
            (typeof body.path !== "string" ||
              (notificationPath != null &&
                notificationPath !== "" &&
                (notificationPath === "/" ||
                  !notificationPath.startsWith("/") ||
                  notificationPath.startsWith("//") ||
                  notificationPath.includes("\\") ||
                  [...notificationPath].some((character) =>
                    /[\u0000-\u001f\u007f-\u009f]/.test(character),
                  ) ||
                  [...notificationPath].length > 512)))
          ) {
            throw new HttpError(400, "invalid path");
          }
          if (
            body.to !== "all" &&
            (!Array.isArray(body.to) ||
              body.to.length === 0 ||
              body.to.length > 256 ||
              body.to.some((id) => typeof id !== "string"))
          ) {
            throw new HttpError(400, "invalid recipients");
          }
          const members = await currentMembers();
          const sender = await currentViewer();
          const recipients =
            body.to === "all"
              ? members.filter((member) => member.id !== sender.id)
              : members.filter((member) => body.to!.includes(member.id));
          const record: NotificationRecord = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            sender: { id: sender.id, username: sender.username },
            requestedTo: body.to,
            recipients: recipients.map(({ id, username }) => ({ id, username })),
            title: body.title.trim(),
            ...(notificationBody ? { body: notificationBody } : {}),
            ...(notificationPath ? { path: notificationPath } : {}),
          };
          await notifications.update((data) => {
            data.notifications.push(record);
          });
          console.info(
            `[maypop] captured notification “${record.title}” for ${record.recipients.length} recipient${record.recipients.length === 1 ? "" : "s"}`,
          );
          sendEmpty(response);
          return;
        }
      }

      if (development.mode === "connected" && remoteSession) {
        await proxyRemoteAppRequest(
          request,
          response,
          url,
          remoteSession,
          token,
          remoteControllers,
        );
        return;
      }

      if (development.mode === "hybrid" && remoteSession) {
        const remoteCapability =
          (url.pathname.startsWith("/app-api/ai/") &&
            development.remoteCapabilities.includes("ai")) ||
          (url.pathname === "/app-api/members" &&
            (development.remoteCapabilities.includes("members") ||
              development.remoteCapabilities.includes("multiplayer"))) ||
          (url.pathname.startsWith("/app-api/multiplayer/") &&
            development.remoteCapabilities.includes("multiplayer")) ||
          (url.pathname.startsWith("/app-api/mcp/") &&
            development.remoteCapabilities.includes("mcp")) ||
          (url.pathname === "/app-api/unfurl" &&
            development.remoteCapabilities.includes("link"));
        if (remoteCapability) {
          await proxyRemoteAppRequest(
            request,
            response,
            url,
            remoteSession,
            token,
            remoteControllers,
          );
          return;
        }
      }

      if (
        mockMcp.servers.length > 0 &&
        url.pathname.startsWith("/app-api/mcp/")
      ) {
        requireDevelopmentScope("mcp:use");
        if (method === "GET" && url.pathname === "/app-api/mcp/servers") {
          sendJson(response, {
            servers: mockMcp.servers.map(({ tools: _tools, ...server }) => server),
          });
          return;
        }
        if (method === "POST" && url.pathname === "/app-api/mcp/tools/list") {
          const body = await readJsonBody<{ serverId?: unknown }>(request);
          const server = mockMcp.servers.find(
            (candidate) => candidate.id === body.serverId,
          );
          if (!server) throw new HttpError(404, "MCP server not found");
          sendJson(response, {
            tools: server.tools.map(({ result: _result, ...tool }) => tool),
          });
          return;
        }
        if (method === "POST" && url.pathname === "/app-api/mcp/tools/call") {
          const body = await readJsonBody<{
            serverId?: unknown;
            name?: unknown;
            arguments?: JsonValue;
          }>(request);
          const server = mockMcp.servers.find(
            (candidate) => candidate.id === body.serverId,
          );
          const tool = server?.tools.find(
            (candidate) => candidate.name === body.name,
          );
          if (!tool) throw new HttpError(404, "MCP tool not found");
          sendJson(
            response,
            tool.result ?? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(body.arguments ?? {}),
                },
              ],
              structuredContent: body.arguments ?? {},
            },
          );
          return;
        }
      }

      if (method === "GET" && url.pathname === "/app-api/members") {
        sendJson(response, {
          members: localMembers(),
          guestCount: development.guestCount,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/app-api/kv/poke") {
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        });
        response.write(": connected\n\n");
        pokeClients.add(response);
        response.on("close", () => pokeClients.delete(response));
        return;
      }

      if (method === "POST" && url.pathname === "/app-api/kv/pull") {
        const body = await readJsonBody<{ cookie?: unknown }>(request);
        const cookie = typeof body.cookie === "number" ? body.cookie : -1;
        const patch =
          body.cookie === kv.value.version
            ? []
            : [
                { op: "clear" },
                ...Object.entries(kv.value.entries)
                  .filter(([key, value]) =>
                    kvPolicyAllows(
                      kvPolicyRules,
                      "sync",
                      key,
                      identity.viewerId,
                      localDataRole(),
                      value,
                    ),
                  )
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([key, value]) => ({ op: "put", key, value })),
              ];
        const lastMutationIDChanges = Object.fromEntries(
          Object.entries(kv.value.clients).filter(
            ([clientId]) => (kv.value.clientVersions[clientId] ?? 0) > cookie,
          ),
        );
        sendJson(response, {
          cookie: kv.value.version,
          lastMutationIDChanges,
          patch,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/app-api/kv/push") {
        requireDevelopmentScope("kv:write");
        const body = await readJsonBody<{
          mutations?: Array<{
            id: number;
            clientID: string;
            name: string;
            args: { key?: unknown; value?: JsonValue };
          }>;
        }>(request);
        await kv.update((data) => {
          for (const mutation of body.mutations ?? []) {
            const previous = data.clients[mutation.clientID] ?? 0;
            if (mutation.id <= previous) continue;
            if (mutation.id !== previous + 1) {
              throw new HttpError(409, "mutation is out of order");
            }
            if (typeof mutation.args?.key !== "string") {
              throw new HttpError(400, "invalid KV key");
            }
            const key = mutation.args.key;
            if (Buffer.byteLength(key) > 1_024) {
              throw new HttpError(400, "KV key exceeds 1024 bytes");
            }
            const current = data.entries[key];
            if (mutation.name === "set") {
              const value = mutation.args.value ?? null;
              if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1_024) {
                throw new HttpError(400, "KV value exceeds 262144 bytes");
              }
              const proposed: KvEntry = {
                value,
                author: identity.viewerId,
                updatedAt: new Date().toISOString(),
              };
              const action: KvPolicyAction = current ? "update" : "create";
              if (
                !kvPolicyAllows(
                  kvPolicyRules,
                  action,
                  key,
                  identity.viewerId,
                  localDataRole(),
                  current,
                  proposed,
                )
              ) {
                throw new HttpError(403, `KV policy denied ${action} for ${key}`);
              }
              data.entries[key] = proposed;
            } else if (mutation.name === "del") {
              if (
                !kvPolicyAllows(
                  kvPolicyRules,
                  "delete",
                  key,
                  identity.viewerId,
                  localDataRole(),
                  current,
                )
              ) {
                throw new HttpError(403, `KV policy denied delete for ${key}`);
              }
              delete data.entries[key];
            } else {
              throw new HttpError(400, `unknown KV mutation: ${mutation.name}`);
            }
            data.version += 1;
            data.clients[mutation.clientID] = mutation.id;
            data.clientVersions[mutation.clientID] = data.version;
          }
        });
        poke();
        sendEmpty(response, 200);
        return;
      }

      if (method === "GET" && url.pathname === "/app-api/drive") {
        const prefix = url.searchParams.get("prefix") ?? "";
        sendJson(
          response,
          drive.value.files
            .filter((file) => file.name.startsWith(prefix))
            .sort((left, right) => left.name.localeCompare(right.name)),
        );
        return;
      }

      if (method === "POST" && url.pathname === "/app-api/drive/presign") {
        requireDevelopmentScope("drive:write");
        const cid = randomUUID();
        sendJson(response, {
          cid,
          fields: {},
          url: `/_maypop/upload/${encodeURIComponent(cid)}`,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/app-api/drive/confirm") {
        requireDevelopmentScope("drive:write");
        const body = await readJsonBody<{
          cid?: string;
          name?: unknown;
          createOnly?: boolean;
        }>(request);
        if (!body.cid) throw new HttpError(400, "missing cid");
        validateCid(body.cid);
        validateDriveName(body.name);
        const existing = drive.value.files.find(
          (file) => file.cid === body.cid,
        );
        if (existing) {
          sendJson(response, existing);
          return;
        }
        if (
          body.createOnly &&
          drive.value.files.some((file) => file.name === body.name)
        ) {
          throw new HttpError(409, "file name already exists");
        }
        const pendingPath = join(pendingDirectory, body.cid);
        const upload = pending.get(body.cid);
        const fileStats = await stat(pendingPath).catch(() => null);
        if (!fileStats) throw new HttpError(404, "uploaded bytes not found");
        const file: DriveFile = {
          id: randomUUID(),
          cid: body.cid,
          name: body.name,
          mimeType: upload?.mimeType ?? null,
          size: upload?.size ?? fileStats.size,
          uploadedBy: identity.viewerId,
          createdAt: new Date().toISOString(),
        };
        await rename(pendingPath, join(driveFilesDirectory, body.cid));
        pending.delete(body.cid);
        await drive.update((data) => data.files.push(file));
        sendJson(response, file);
        return;
      }

      if (url.pathname === "/app-api/drive/file") {
        const name = url.searchParams.get("name");
        if (method === "GET") {
          const file = [...drive.value.files]
            .reverse()
            .find((candidate) => candidate.name === name);
          if (!file) throw new HttpError(404, "file not found");
          sendJson(response, {
            file,
            url: `/_maypop/drive/${encodeURIComponent(file.cid)}`,
          });
          return;
        }
        if (method === "DELETE") {
          requireDevelopmentScope("drive:write");
          const removed = drive.value.files.filter(
            (file) => file.name === name,
          );
          if (removed.length === 0) throw new HttpError(404, "file not found");
          await drive.update((data) => {
            data.files = data.files.filter((file) => file.name !== name);
          });
          await Promise.all(
            removed.map((file) =>
              rm(join(driveFilesDirectory, file.cid), { force: true }),
            ),
          );
          sendEmpty(response);
          return;
        }
      }

      if (url.pathname.startsWith("/app-api/drive/")) {
        const cid = decodeURIComponent(
          url.pathname.slice("/app-api/drive/".length),
        );
        validateCid(cid);
        const file = drive.value.files.find(
          (candidate) => candidate.cid === cid,
        );
        if (!file) throw new HttpError(404, "file not found");
        if (method === "GET") {
          sendJson(response, {
            url: `/_maypop/drive/${encodeURIComponent(cid)}`,
          });
          return;
        }
        if (method === "DELETE") {
          requireDevelopmentScope("drive:write");
          await drive.update((data) => {
            data.files = data.files.filter(
              (candidate) => candidate.cid !== cid,
            );
          });
          await rm(join(driveFilesDirectory, cid), { force: true });
          sendEmpty(response);
          return;
        }
      }

      const capability = url.pathname.split("/")[2];
      if (capability && !["me", "kv", "drive"].includes(capability)) {
        throw new HttpError(
          501,
          `The local Maypop sandbox does not implement ${capability} yet.`,
          "sandbox_capability_unavailable",
        );
      }
      throw new HttpError(404, "not found");
    }

    return {
      dataDirectory,
      handle,
      close() {
        for (const response of pokeClients) response.end();
        pokeClients.clear();
        for (const controller of remoteControllers) controller.abort();
        remoteControllers.clear();
        releaseLock();
      },
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}
