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
  sessionId: string;
  token: string;
  expiresIn: number;
  refreshToken: string;
  scopes: string;
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

/** Ask the installed CLI for an app session using its normal profile rules. */
export function runSdkSession(
  root: string,
  profile?: string,
): Promise<AppSession> {
  const executable = process.env.MAYPOP_CLI ?? "maypop";
  const args = [...(profile ? ["--profile", profile] : []), "sdk-session"];
  return new Promise((resolveSession, rejectSession) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      rejectSession(
        new Error(
          `Could not run ${executable}. Install or update the Maypop CLI, then run \`maypop auth\`.`,
          { cause: error },
        ),
      );
    });
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        rejectSession(
          new Error(
            detail ||
              "Maypop could not create a development session. Run `maypop auth` and confirm this account can access the app.",
          ),
        );
        return;
      }
      try {
        const session = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        ) as Partial<AppSession>;
        if (
          !session.apiUrl ||
          !session.appId ||
          !session.sessionId ||
          !session.token ||
          !session.refreshToken ||
          !session.scopes ||
          typeof session.expiresIn !== "number" ||
          session.expiresIn <= 0
        ) {
          throw new Error("the CLI returned an incomplete session");
        }
        resolveSession(session as AppSession);
      } catch (error) {
        rejectSession(
          new Error(
            "The Maypop CLI returned an invalid SDK session. Update the CLI and try again.",
            { cause: error },
          ),
        );
      }
    });
  });
}

/** App-scoped access held by the Node development host, never by app code. */
export class RemoteAppSession {
  readonly apiUrl: string;
  readonly appId: string;
  readonly sessionId: string;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;
  private grantedScopes: string;
  private refreshing?: Promise<void>;

  constructor(session: AppSession) {
    this.apiUrl = session.apiUrl.replace(/\/$/, "");
    this.appId = session.appId;
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
