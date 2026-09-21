import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
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

const MAX_BODY_BYTES = 51 * 1024 * 1024;
const SANDBOX_SCOPES = "identity:read kv:read kv:write drive:read drive:write";
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
  appRequestToken: string,
  kvPullIntervalMs: number | undefined,
): string {
  const config = JSON.stringify({
    appId: identity.appId,
    appRequestToken,
    kvPullIntervalMs,
    token,
    scopes: SANDBOX_SCOPES,
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
        font-size: 11px; pointer-events: none;
      }
    </style>
  </head>
  <body>
    <iframe
      id="app"
      title="App"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox allow-downloads"
      allow="autoplay; clipboard-read; clipboard-write; encrypted-media; fullscreen; geolocation; microphone; camera; display-capture; accelerometer; gyroscope; magnetometer"
    ></iframe>
    <div id="badge">Maypop sandbox</div>
    <script>
      const config = ${config};
      const frame = document.getElementById("app");
      const badge = document.getElementById("badge");
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

      function connect() {
        if (!frame.contentWindow) return;
        port?.close();
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = (event) => {
          if (event.data?.type === "maypop:ready") badge.textContent = "Maypop sandbox · connected";
          if (event.data?.type === "maypop:refresh") {
            port.postMessage({ type: "maypop:token", token: config.token, expiresIn: 86400, scopes: config.scopes });
          }
          const unsupportedReplies = {
            "maypop:open-app": "maypop:open-app-error",
            "maypop:open-group-settings": "maypop:open-group-settings-error",
            "maypop:share": "maypop:share-error",
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
        frame.contentWindow.postMessage({
          type: "maypop:init",
          context: {
            appId: config.appId,
            apiBase: location.origin,
            kvPullIntervalMs: config.kvPullIntervalMs,
          },
          token: { token: config.token, expiresIn: 86400, scopes: config.scopes },
        }, location.origin, [channel.port2]);
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
    const driveDirectory = join(dataDirectory, "drive");
    const driveFilesDirectory = join(driveDirectory, "files");
    const pendingDirectory = join(driveDirectory, "pending");
    await mkdir(driveFilesDirectory, { recursive: true });
    await rm(pendingDirectory, { recursive: true, force: true });
    await mkdir(pendingDirectory, { recursive: true });

    const identity = await loadIdentity(dataDirectory);
    const token = randomBytes(32).toString("base64url");
    const appRequestToken = randomBytes(18).toString("base64url");
    const kvPath = join(dataDirectory, "kv.json");
    const kvData = await readJson<Partial<KvData>>(kvPath, {
      schemaVersion: 1,
      version: 0,
      entries: {},
      clients: {},
      clientVersions: {},
    });
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
    if (migrateKvData) await writeJsonAtomic(kvPath, kvData);
    const kv = new JsonStore(kvPath, kvData as KvData);
    const drivePath = join(driveDirectory, "index.json");
    const driveData = await readJson<Partial<DriveData>>(drivePath, {
      schemaVersion: 1,
      files: [],
    });
    if (driveData.schemaVersion != null && driveData.schemaVersion !== 1) {
      throw new Error(
        `Unsupported Maypop Drive schema version in ${drivePath}.`,
      );
    }
    const migrateDriveData = driveData.schemaVersion !== 1;
    driveData.schemaVersion = 1;
    driveData.files ??= [];
    if (migrateDriveData) await writeJsonAtomic(drivePath, driveData);
    const drive = new JsonStore(drivePath, driveData as DriveData);
    const pending = new Map<
      string,
      { mimeType: string | null; size: number }
    >();
    const pokeClients = new Set<ServerResponse>();

    function poke(): void {
      for (const response of pokeClients) response.write("data: poke\n\n");
    }

    async function handle(
      request: IncomingMessage,
      response: ServerResponse,
      next: () => void,
    ): Promise<void> {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://maypop.local");

      if (isSandboxDocumentRequest(method, request, url, appRequestToken)) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(
          sandboxHtml(
            identity,
            token,
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
        sendJson(response, {
          id: identity.viewerId,
          username: options.username ?? "Developer",
          role: "admin",
          avatarUrl: null,
          connected: true,
          isAnonymous: false,
          scopes: SANDBOX_SCOPES,
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
            if (mutation.name === "set") {
              data.entries[mutation.args.key] = {
                value: mutation.args.value ?? null,
                author: identity.viewerId,
                updatedAt: new Date().toISOString(),
              };
            } else if (mutation.name === "del") {
              delete data.entries[mutation.args.key];
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
        const cid = randomUUID();
        sendJson(response, {
          cid,
          fields: {},
          url: `/_maypop/upload/${encodeURIComponent(cid)}`,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/app-api/drive/confirm") {
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
        releaseLock();
      },
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}
