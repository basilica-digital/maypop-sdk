import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

const MAX_BODY_BYTES = 51 * 1024 * 1024;
const DEV_CONFIG_NAME = "dev.json";

export type DevelopmentMode = "sandbox" | "hybrid" | "connected";
export type NotificationMode = "inspect" | "live" | "disabled";
export type RemoteCapability = "ai" | "members" | "link";

export type DevelopmentConfig = {
  mode: DevelopmentMode;
  profile?: string;
  remoteCapabilities: RemoteCapability[];
  notifications: NotificationMode;
};

type AppSession = {
  apiUrl: string;
  appId: string;
  profile: string;
  sessionId: string;
  token: string;
  expiresIn: number;
  refreshToken: string;
  scopes: string;
};

type SavedCredentials = {
  apiUrl: string;
  token: string;
};

type ProfileStore = {
  version: number;
  defaultProfile: string;
  profiles: Record<string, SavedCredentials>;
};

export type AppMember = {
  id: string;
  username: string;
  role: string;
  avatarUrl: string | null;
  connected: boolean;
};

export type AppMe = AppMember & { isAnonymous: boolean; scopes: string };

function configError(path: string, message: string): Error {
  return new Error(`Invalid Maypop development config at ${path}: ${message}`);
}

/** Read and validate the developer-local `.maypop/dev.json`. */
export async function loadDevelopmentConfig(
  dataDirectory: string,
): Promise<DevelopmentConfig> {
  const path = join(dataDirectory, DEV_CONFIG_NAME);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {
        mode: "sandbox",
        remoteCapabilities: [],
        notifications: "inspect",
      };
    }
    throw new Error(`Could not read Maypop development config at ${path}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw configError(path, "the file is not valid JSON");
    }
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError(path, "the top-level value must be an object");
  }
  const raw = parsed as Record<string, unknown>;

  const mode = raw.mode ?? "sandbox";
  if (!(["sandbox", "hybrid", "connected"] as unknown[]).includes(mode)) {
    throw configError(
      path,
      '`mode` must be "sandbox", "hybrid", or "connected"',
    );
  }
  const notifications = raw.notifications ?? "inspect";
  if (!(["inspect", "live", "disabled"] as unknown[]).includes(notifications)) {
    throw configError(
      path,
      '`notifications` must be "inspect", "live", or "disabled"',
    );
  }
  if (notifications === "live" && mode !== "connected") {
    throw configError(
      path,
      '`notifications: "live"` requires `mode: "connected"`',
    );
  }
  if (
    raw.profile != null &&
    (typeof raw.profile !== "string" || !raw.profile.trim())
  ) {
    throw configError(path, "`profile` must be a non-empty string");
  }

  const configuredCapabilities = raw.remoteCapabilities;
  if (
    configuredCapabilities != null &&
    (!Array.isArray(configuredCapabilities) ||
      configuredCapabilities.some(
        (value) => !["ai", "members", "link"].includes(String(value)),
      ))
  ) {
    throw configError(
      path,
      '`remoteCapabilities` may contain only "ai", "members", and "link"',
    );
  }
  if (configuredCapabilities != null && mode !== "hybrid") {
    throw configError(
      path,
      "`remoteCapabilities` is only valid in hybrid mode",
    );
  }

  return {
    mode: mode as DevelopmentMode,
    ...(typeof raw.profile === "string"
      ? { profile: raw.profile.trim() }
      : {}),
    remoteCapabilities:
      mode === "hybrid"
        ? ((configuredCapabilities ?? ["ai", "members", "link"]) as RemoteCapability[])
        : [],
    notifications: notifications as NotificationMode,
  };
}

function profileStorePath(): string {
  if (process.env.MAYPOP_CONFIG_DIR) {
    return join(process.env.MAYPOP_CONFIG_DIR, "profiles.json");
  }
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "maypop", "profiles.json");
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "maypop", "profiles.json");
  }
  if (!process.env.HOME) {
    throw new Error(
      "Maypop could not find a config directory; set MAYPOP_CONFIG_DIR",
    );
  }
  return join(process.env.HOME, ".config", "maypop", "profiles.json");
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function validateProfileName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      "Maypop profile names may contain only letters, numbers, `-`, and `_`",
    );
  }
}

async function loadProfileStore(): Promise<ProfileStore> {
  const path = profileStorePath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(
        `No Maypop profiles were found at ${path}. Run \`maypop auth\` first.`,
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Maypop profiles file at ${path}`);
    }
    throw new Error(`Could not read Maypop profiles from ${path}`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(`Invalid Maypop profiles file at ${path}`);
  }
  const store = parsed as Partial<ProfileStore>;
  if (
    store.version !== 1 ||
    typeof store.defaultProfile !== "string" ||
    typeof store.profiles !== "object" ||
    store.profiles === null ||
    Array.isArray(store.profiles) ||
    !store.profiles[store.defaultProfile]
  ) {
    throw new Error(`Unsupported or invalid Maypop profiles file at ${path}`);
  }
  for (const [name, credentials] of Object.entries(store.profiles)) {
    validateProfileName(name);
    if (
      typeof credentials?.apiUrl !== "string" ||
      !credentials.apiUrl ||
      typeof credentials.token !== "string" ||
      !credentials.token
    ) {
      throw new Error(`Invalid Maypop profile \`${name}\` at ${path}`);
    }
  }
  return store as ProfileStore;
}

function selectProfile(
  store: ProfileStore,
  apiUrl: string,
  configuredProfile?: string,
): { name: string; credentials: SavedCredentials } {
  const requested = configuredProfile ?? process.env.MAYPOP_PROFILE;
  if (requested) {
    validateProfileName(requested);
    const credentials = store.profiles[requested];
    if (!credentials) {
      throw new Error(
        `Maypop profile \`${requested}\` is not authenticated. Run \`maypop --profile ${requested} --url ${apiUrl} auth\`.`,
      );
    }
    if (normalizeUrl(credentials.apiUrl) !== apiUrl) {
      throw new Error(
        `Maypop profile \`${requested}\` uses ${normalizeUrl(credentials.apiUrl)}, but this app uses ${apiUrl}`,
      );
    }
    return { name: requested, credentials };
  }

  const preferred = store.profiles[store.defaultProfile];
  if (normalizeUrl(preferred.apiUrl) === apiUrl) {
    return { name: store.defaultProfile, credentials: preferred };
  }
  const matching = Object.entries(store.profiles).find(
    ([, credentials]) => normalizeUrl(credentials.apiUrl) === apiUrl,
  );
  if (matching) {
    return { name: matching[0], credentials: matching[1] };
  }
  throw new Error(
    `No authenticated Maypop profile matches ${apiUrl}. Run \`maypop --url ${apiUrl} auth\`.`,
  );
}

function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      rejectOutput(new Error("Git is required for connected Maypop development", { cause: error }));
    });
    child.once("close", (code) => {
      if (code !== 0) {
        rejectOutput(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              "Could not read the Maypop repository configuration",
          ),
        );
        return;
      }
      resolveOutput(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

async function repositoryConnection(
  root: string,
): Promise<{ appId: string; apiUrl: string }> {
  const repository = await runGit(root, ["rev-parse", "--show-toplevel"]);
  const [appId, configuredApiUrl] = await Promise.all([
    runGit(repository, ["config", "--local", "--get", "maypop.app-id"]),
    runGit(repository, ["config", "--local", "--get", "maypop.api-url"]),
  ]);
  if (!appId || !configuredApiUrl) {
    throw new Error(
      "This repository is not connected to Maypop. Run `maypop init` first.",
    );
  }
  return { appId, apiUrl: normalizeUrl(configuredApiUrl) };
}

/** Mint an app-scoped session from the authenticated local profile store. */
export async function mintDevelopmentSession(
  root: string,
  configuredProfile?: string,
): Promise<AppSession> {
  const [{ appId, apiUrl }, store] = await Promise.all([
    repositoryConnection(root),
    loadProfileStore(),
  ]);
  const profile = selectProfile(store, apiUrl, configuredProfile);
  const response = await fetch(`${apiUrl}/app-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${profile.credentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      appId,
      deviceLabel: "Maypop SDK development",
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(
      detail ||
        `Maypop could not create a development session (${response.status}). Confirm profile \`${profile.name}\` can access this app.`,
    );
  }
  const session = (await response.json()) as Partial<AppSession>;
  if (
    !session.sessionId ||
    !session.token ||
    !session.refreshToken ||
    !session.scopes ||
    typeof session.expiresIn !== "number" ||
    session.expiresIn <= 0
  ) {
    throw new Error("Maypop returned an invalid development session");
  }
  return {
    apiUrl,
    appId,
    profile: profile.name,
    sessionId: session.sessionId,
    token: session.token,
    expiresIn: session.expiresIn,
    refreshToken: session.refreshToken,
    scopes: session.scopes,
  };
}

/** App-scoped access held by the Node development host, never by app code. */
export class RemoteAppSession {
  readonly apiUrl: string;
  readonly appId: string;
  readonly profile: string;
  readonly sessionId: string;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;
  private grantedScopes: string;
  private refreshing?: Promise<void>;

  constructor(session: AppSession) {
    this.apiUrl = session.apiUrl.replace(/\/$/, "");
    this.appId = session.appId;
    this.profile = session.profile;
    this.sessionId = session.sessionId;
    this.accessToken = session.token;
    this.refreshToken = session.refreshToken;
    this.expiresAt = Date.now() + session.expiresIn * 1_000;
    this.grantedScopes = session.scopes;
  }

  get scopes(): string {
    return this.grantedScopes;
  }

  async currentToken(): Promise<string> {
    if (Date.now() >= this.expiresAt - 60_000) await this.refresh();
    return this.accessToken;
  }

  async refresh(): Promise<void> {
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshNow(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/app-sessions/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    if (!response.ok) {
      throw new Error(
        `Maypop development session refresh failed (${response.status}). Restart the development server after authenticating again.`,
      );
    }
    const refreshed = (await response.json()) as {
      token?: string;
      expiresIn?: number;
      scopes?: string;
    };
    if (!refreshed.token || typeof refreshed.expiresIn !== "number") {
      throw new Error("Maypop returned an invalid refreshed app session");
    }
    this.accessToken = refreshed.token;
    this.expiresAt = Date.now() + refreshed.expiresIn * 1_000;
    this.grantedScopes = refreshed.scopes ?? this.grantedScopes;
  }
}

/** Make a small authenticated app-API read, refreshing once after a 401. */
export async function remoteJson<T>(
  session: RemoteAppSession,
  path: string,
): Promise<T> {
  let response = await fetch(`${session.apiUrl}/app-api${path}`, {
    headers: { Authorization: `Bearer ${await session.currentToken()}` },
  });
  if (response.status === 401) {
    await session.refresh();
    response = await fetch(`${session.apiUrl}/app-api${path}`, {
      headers: { Authorization: `Bearer ${await session.currentToken()}` },
    });
  }
  if (!response.ok) {
    throw new Error(`Maypop ${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("remote request is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request: IncomingMessage, token: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value == null ||
      [
        "authorization",
        "connection",
        "content-length",
        "cookie",
        "host",
        "transfer-encoding",
      ].includes(name.toLowerCase())
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/** Stream one local app-API request through the app-scoped remote session. */
export async function proxyRemoteAppRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  session: RemoteAppSession,
  localToken: string,
  controllers: Set<AbortController>,
): Promise<void> {
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readBody(request);
  const remoteUrl = new URL(
    `/app-api${url.pathname.slice("/app-api".length)}`,
    session.apiUrl,
  );
  remoteUrl.search = url.search;
  if (remoteUrl.searchParams.get("token") === localToken) {
    remoteUrl.searchParams.set("token", await session.currentToken());
  }

  async function send(
    retried: boolean,
  ): Promise<{ result: Response; controller: AbortController }> {
    const controller = new AbortController();
    controllers.add(controller);
    response.once("close", () => controller.abort());
    let result: Response;
    try {
      result = await fetch(remoteUrl, {
        method,
        headers: requestHeaders(request, await session.currentToken()),
        ...(body ? { body } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      controllers.delete(controller);
      throw error;
    }
    if (result.status === 401 && !retried) {
      controller.abort();
      controllers.delete(controller);
      await session.refresh();
      if (remoteUrl.searchParams.has("token")) {
        remoteUrl.searchParams.set("token", await session.currentToken());
      }
      return send(true);
    }
    return { result, controller };
  }

  const { result: remote, controller } = await send(false);
  const headers: Record<string, string> = {};
  remote.headers.forEach((value, name) => {
    if (
      ![
        "connection",
        "content-encoding",
        "content-length",
        "transfer-encoding",
      ].includes(name)
    ) {
      headers[name] = value;
    }
  });
  response.writeHead(remote.status, headers);
  if (!remote.body) {
    controllers.delete(controller);
    response.end();
    return;
  }
  try {
    const reader = remote.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controllers.delete(controller);
    response.end();
  }
}
