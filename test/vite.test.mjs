import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";

import { maypop } from "@basilica-digital/maypop-sdk/vite";

test("the public plugin type is independent of the SDK's Vite version", async () => {
  const declaration = await readFile(join(process.cwd(), "dist/vite.d.ts"), "utf8");

  assert.doesNotMatch(declaration, /from ["']vite["']/);
  assert.match(declaration, /interface MaypopVitePlugin/);
});

function readSandboxConfigValue(html, name) {
  const match = html.match(new RegExp(`"${name}":"([^"]+)"`));
  assert.ok(match, `sandbox HTML exposes ${name}`);
  return match[1];
}

async function startMiddlewareSandbox(root) {
  const middleware = [];
  const lifecycle = new EventEmitter();
  const plugin = maypop();
  const configure =
    typeof plugin.configureServer === "function"
      ? plugin.configureServer
      : plugin.configureServer.handler;
  await configure({
    config: { root, logger: { info() {} } },
    httpServer: lifecycle,
    middlewares: {
      use(handler) {
        middleware.push(handler);
      },
    },
  });

  const server = createHttpServer((request, response) => {
    middleware[0](request, response, () => {
      response.writeHead(418);
      response.end("vite app");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    async close() {
      lifecycle.emit("close");
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function readStreamChunk(reader) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out waiting for sandbox stream data")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("the Vite plugin hosts and persists sandbox KV and Drive", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-vite-test-"));
  let sandbox = await startMiddlewareSandbox(root);
  let pokeAbort;
  let pokeReader;

  try {
    const host = await fetch(sandbox.url, {
      headers: { Accept: "text/html" },
    });
    assert.equal(host.status, 200);
    const hostHtml = await host.text();
    assert.match(hostHtml, /Maypop sandbox/);
    assert.match(hostHtml, /sandbox="allow-scripts allow-same-origin/);
    const token = readSandboxConfigValue(hostHtml, "token");
    const appRequestToken = readSandboxConfigValue(hostHtml, "appRequestToken");
    const authorization = { Authorization: `Bearer ${token}` };
    pokeAbort = new AbortController();
    const pokeResponse = await fetch(
      `${sandbox.url}/app-api/kv/poke?token=${encodeURIComponent(token)}`,
      { signal: pokeAbort.signal },
    );
    assert.equal(pokeResponse.status, 200);
    pokeReader = pokeResponse.body.getReader();
    const decoder = new TextDecoder();
    const connected = await readStreamChunk(pokeReader);
    assert.match(decoder.decode(connected.value), /: connected/);

    const deepLink = await fetch(`${sandbox.url}/todos/42?view=details`, {
      headers: { Accept: "text/html" },
    });
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /Maypop sandbox/);

    const app = await fetch(
      `${sandbox.url}/?__maypop_app=${encodeURIComponent(appRequestToken)}`,
      {
        headers: { Accept: "text/html" },
      },
    );
    assert.equal(app.status, 418);
    const invalidMarker = await fetch(`${sandbox.url}/?__maypop_app=1`, {
      headers: { Accept: "text/html" },
    });
    assert.match(await invalidMarker.text(), /Maypop sandbox/);

    const unauthorized = await fetch(`${sandbox.url}/app-api/me`, {
      headers: { Authorization: "Bearer maypop-local-sandbox" },
    });
    assert.equal(unauthorized.status, 401);

    await assert.rejects(
      startMiddlewareSandbox(root),
      /already in use by another development server/,
    );

    const push = await fetch(`${sandbox.url}/app-api/kv/push`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientGroupID: "group-1",
        mutations: [
          {
            id: 1,
            clientID: "client-1",
            name: "set",
            args: { key: "count", value: 3 },
          },
        ],
      }),
    });
    assert.equal(push.status, 200);
    const poked = await readStreamChunk(pokeReader);
    assert.match(decoder.decode(poked.value), /data: poke/);
    pokeAbort.abort();
    await pokeReader.cancel().catch(() => {});

    const pull = await fetch(`${sandbox.url}/app-api/kv/pull`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ clientGroupID: "group-1", cookie: null }),
    });
    const pulled = await pull.json();
    assert.deepEqual(pulled.patch[0], { op: "clear" });
    assert.equal(pulled.patch[1].op, "put");
    assert.equal(pulled.patch[1].key, "count");
    assert.equal(pulled.patch[1].value.value, 3);
    assert.equal(
      pulled.patch[1].value.author,
      JSON.parse(await readFile(join(root, ".maypop/config.json"), "utf8"))
        .viewerId,
    );
    assert.match(pulled.patch[1].value.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(pulled.lastMutationIDChanges, { "client-1": 1 });

    const settled = await fetch(`${sandbox.url}/app-api/kv/pull`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ clientGroupID: "group-1", cookie: pulled.cookie }),
    }).then((response) => response.json());
    assert.deepEqual(settled.patch, []);
    assert.deepEqual(settled.lastMutationIDChanges, {});

    const presign = await fetch(`${sandbox.url}/app-api/drive/presign`, {
      method: "POST",
      headers: authorization,
    }).then((response) => response.json());
    const form = new FormData();
    form.append("Content-Type", "text/plain");
    form.append("file", new Blob(["hello"], { type: "text/plain" }));
    const upload = await fetch(new URL(presign.url, sandbox.url), {
      method: "POST",
      body: form,
    });
    assert.equal(upload.status, 204);

    const confirmed = await fetch(`${sandbox.url}/app-api/drive/confirm`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ cid: presign.cid, name: "hello.txt" }),
    }).then((response) => response.json());
    assert.equal(confirmed.name, "hello.txt");
    assert.equal(confirmed.size, 5);

    const fileHandle = await fetch(
      `${sandbox.url}/app-api/drive/file?name=hello.txt`,
      { headers: authorization },
    ).then((response) => response.json());
    assert.equal(
      await fetch(new URL(fileHandle.url, sandbox.url)).then((response) =>
        response.text(),
      ),
      "hello",
    );

    const partialFile = await fetch(new URL(fileHandle.url, sandbox.url), {
      headers: { Range: "bytes=1-3" },
    });
    assert.equal(partialFile.status, 206);
    assert.equal(partialFile.headers.get("content-range"), "bytes 1-3/5");
    assert.equal(await partialFile.text(), "ell");

    const invalidRange = await fetch(new URL(fileHandle.url, sandbox.url), {
      headers: { Range: "bytes=8-12" },
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), "bytes */5");

    const me = await fetch(`${sandbox.url}/app-api/me`, {
      headers: authorization,
    }).then((response) => response.json());
    assert.match(me.scopes, /notify:send/);
    const members = await fetch(`${sandbox.url}/app-api/members`, {
      headers: authorization,
    }).then((response) => response.json());
    assert.equal(members.members[0].id, me.id);
    assert.equal(members.members[0].username, "Developer");

    const notified = await fetch(`${sandbox.url}/app-api/notify`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: [me.id],
        title: "Your turn",
        body: "Open the shared board.",
        path: "/board/7",
      }),
    });
    assert.equal(notified.status, 204);
    const outbox = await fetch(
      `${sandbox.url}/_maypop/notifications.json`,
    ).then((response) => response.json());
    assert.equal(outbox.notifications.length, 1);
    assert.equal(outbox.notifications[0].recipients[0].username, "Developer");
    assert.equal(outbox.notifications[0].path, "/board/7");
    const inspector = await fetch(`${sandbox.url}/_maypop/notifications`).then(
      (response) => response.text(),
    );
    assert.match(inspector, /Notification outbox/);

    const worker = await fetch(`${sandbox.url}/_maypop-sw.js`).then(
      (response) => response.text(),
    );
    assert.match(worker, /_upload/);

    await sandbox.close();
    sandbox = await startMiddlewareSandbox(root);
    const restartedHostHtml = await fetch(sandbox.url, {
      headers: { Accept: "text/html" },
    }).then((response) => response.text());
    const restartedToken = readSandboxConfigValue(restartedHostHtml, "token");
    assert.notEqual(restartedToken, token);
    const restartedAuthorization = {
      Authorization: `Bearer ${restartedToken}`,
    };
    const persisted = await fetch(`${sandbox.url}/app-api/kv/pull`, {
      method: "POST",
      headers: {
        ...restartedAuthorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientGroupID: "group-2", cookie: null }),
    }).then((response) => response.json());
    assert.equal(persisted.patch[1].value.value, 3);

    const persistedFile = await fetch(
      `${sandbox.url}/app-api/drive/file?name=hello.txt`,
      { headers: restartedAuthorization },
    ).then((response) => response.json());
    assert.equal(
      await fetch(new URL(persistedFile.url, sandbox.url)).then((response) =>
        response.text(),
      ),
      "hello",
    );

    const driveIndex = JSON.parse(
      await readFile(join(root, ".maypop/drive/index.json"), "utf8"),
    );
    assert.equal(driveIndex.schemaVersion, 1);
    assert.equal(driveIndex.files[0].name, "hello.txt");
    const kvIndex = JSON.parse(
      await readFile(join(root, ".maypop/kv.json"), "utf8"),
    );
    assert.equal(kvIndex.schemaVersion, 1);
  } finally {
    pokeAbort?.abort();
    if (pokeReader) await pokeReader.cancel().catch(() => {});
    await sandbox.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("the plugin runs inside Vite with base paths and routed documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-real-vite-test-"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><body><main id="app">Vite app</main></body></html>',
  );
  const server = await createViteServer({
    base: "/workspace/",
    configFile: false,
    logLevel: "silent",
    plugins: [maypop()],
    root,
    server: { host: "127.0.0.1", port: 0 },
  });

  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;

    const host = await fetch(`${url}/workspace/todos/42?view=details`, {
      headers: { Accept: "text/html" },
    });
    assert.equal(host.status, 200);
    const hostHtml = await host.text();
    assert.match(hostHtml, /Maypop sandbox/);
    const appRequestToken = readSandboxConfigValue(hostHtml, "appRequestToken");

    const app = await fetch(
      `${url}/workspace/todos/42?view=details&__maypop_app=${encodeURIComponent(appRequestToken)}`,
      { headers: { Accept: "text/html" } },
    );
    const appHtml = await app.text();
    assert.equal(app.status, 200);
    assert.match(appHtml, /<main id="app">Vite app<\/main>/);
    assert.match(appHtml, /\/workspace\/@vite\/client/);
    assert.match(appHtml, /__maypop_app/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid persisted data fails clearly without leaving the directory locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-invalid-data-test-"));
  const dataDirectory = join(root, ".maypop");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, "kv.json"), "not json");

  try {
    await assert.rejects(
      startMiddlewareSandbox(root),
      /kv\.json is not valid JSON/,
    );
    await rm(join(dataDirectory, "kv.json"));
    const sandbox = await startMiddlewareSandbox(root);
    await sandbox.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development config rejects live notifications outside connected mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-invalid-dev-config-test-"));
  const dataDirectory = join(root, ".maypop");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "dev.json"),
    JSON.stringify({ mode: "hybrid", notifications: "live" }),
  );

  try {
    await assert.rejects(
      startMiddlewareSandbox(root),
      /notifications.*live.*requires.*connected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development config requires a JSON object", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-invalid-dev-shape-test-"));
  const dataDirectory = join(root, ".maypop");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, "dev.json"), "null");

  try {
    await assert.rejects(
      startMiddlewareSandbox(root),
      /top-level value must be an object/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid mode reads the selected profile and mints its own app session", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-hybrid-test-"));
  const dataDirectory = join(root, ".maypop");
  const profileDirectory = join(root, "profiles");
  const appId = "00000000-0000-4000-8000-000000000001";
  const viewerId = "00000000-0000-4000-8000-000000000002";
  const teammateId = "00000000-0000-4000-8000-000000000003";
  let mintRequests = 0;
  let remoteRequests = 0;
  let refreshRequests = 0;
  const api = createHttpServer(async (request, response) => {
    if (request.url === "/app-sessions") {
      mintRequests += 1;
      assert.equal(request.headers.authorization, "Bearer cli-profile-token");
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
        appId,
        deviceLabel: "Maypop SDK development",
      });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          sessionId: "00000000-0000-4000-8000-000000000004",
          token: "remote-app-token",
          expiresIn: 1,
          refreshToken: "remote-refresh-token",
          scopes: "identity:read group:read ai:use notify:send",
        }),
      );
      return;
    }
    if (request.url === "/app-sessions/refresh") {
      refreshRequests += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          token: "remote-app-token-refreshed",
          expiresIn: 300,
          scopes: "identity:read group:read ai:use notify:send",
        }),
      );
      return;
    }
    assert.equal(
      request.headers.authorization,
      "Bearer remote-app-token-refreshed",
    );
    remoteRequests += 1;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/app-api/me") {
      response.end(
        JSON.stringify({
          id: viewerId,
          username: "Authenticated developer",
          role: "admin",
          avatarUrl: null,
          connected: true,
          isAnonymous: false,
          scopes: "identity:read group:read ai:use notify:send",
        }),
      );
      return;
    }
    if (request.url === "/app-api/members") {
      response.end(
        JSON.stringify({
          members: [
            { id: viewerId, username: "Authenticated developer", role: "admin", avatarUrl: null, connected: true },
            { id: teammateId, username: "Teammate", role: "writer", avatarUrl: null, connected: false },
          ],
          guestCount: 0,
        }),
      );
      return;
    }
    if (request.url === "/app-api/ai/models") {
      response.end(JSON.stringify({ data: [{ id: "fast", description: "Fast" }] }));
      return;
    }
    if (request.url === "/app-api/kv/pull") {
      response.end(
        JSON.stringify({
          cookie: 17,
          lastMutationIDChanges: {},
          patch: [{ op: "clear" }, { op: "put", key: "remote", value: { value: true } }],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress !== "string");
  const apiUrl = `http://127.0.0.1:${apiAddress.port}`;

  await mkdir(dataDirectory, { recursive: true });
  await mkdir(profileDirectory, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "--local", "maypop.app-id", appId], {
    cwd: root,
  });
  execFileSync("git", ["config", "--local", "maypop.api-url", apiUrl], {
    cwd: root,
  });
  const profile = (profileApiUrl, token, username) => ({
    apiUrl: profileApiUrl,
    token,
    expiresAt: "2027-01-01T00:00:00Z",
    user: {
      id: viewerId,
      username,
      name: null,
      email: `${username}@example.com`,
      gitUserId: `user_${username}`,
      gitServerUrl: `${profileApiUrl}/git`,
    },
  });
  await writeFile(
    join(profileDirectory, "profiles.json"),
    JSON.stringify({
      version: 1,
      defaultProfile: "other",
      profiles: {
        dev: profile(apiUrl, "cli-profile-token", "developer"),
        other: profile("https://other.example", "other-token", "other"),
      },
    }),
  );
  await writeFile(
    join(dataDirectory, "dev.json"),
    JSON.stringify({ mode: "hybrid", profile: "dev", notifications: "inspect" }),
  );

  const previousConfigDirectory = process.env.MAYPOP_CONFIG_DIR;
  const previousProfile = process.env.MAYPOP_PROFILE;
  process.env.MAYPOP_CONFIG_DIR = profileDirectory;
  delete process.env.MAYPOP_PROFILE;
  let sandbox;
  try {
    sandbox = await startMiddlewareSandbox(root);
    const hostHtml = await fetch(sandbox.url, {
      headers: { Accept: "text/html" },
    }).then((response) => response.text());
    const token = readSandboxConfigValue(hostHtml, "token");
    const authorization = { Authorization: `Bearer ${token}` };
    assert.match(hostHtml, /"mode":"hybrid"/);
    assert.match(hostHtml, /ai:use/);

    const me = await fetch(`${sandbox.url}/app-api/me`, {
      headers: authorization,
    }).then((response) => response.json());
    assert.equal(me.username, "Authenticated developer");
    const models = await fetch(`${sandbox.url}/app-api/ai/models`, {
      headers: authorization,
    }).then((response) => response.json());
    assert.equal(models.data[0].id, "fast");

    const localPull = await fetch(`${sandbox.url}/app-api/kv/pull`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: null }),
    }).then((response) => response.json());
    assert.equal(localPull.patch[0].op, "clear");

    await fetch(`${sandbox.url}/app-api/notify`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "all", title: "Review requested" }),
    });
    const outbox = await fetch(
      `${sandbox.url}/_maypop/notifications.json`,
    ).then((response) => response.json());
    assert.deepEqual(outbox.notifications[0].recipients, [
      { id: teammateId, username: "Teammate" },
    ]);
    assert.equal(remoteRequests, 5);
    assert.equal(refreshRequests, 1);
    assert.equal(mintRequests, 1);

    await sandbox.close();
    sandbox = undefined;
    await writeFile(
      join(dataDirectory, "dev.json"),
      JSON.stringify({ mode: "connected", notifications: "inspect" }),
    );
    await writeFile(join(dataDirectory, "kv.json"), "not local data");
    remoteRequests = 0;
    sandbox = await startMiddlewareSandbox(root);
    const connectedHtml = await fetch(sandbox.url, {
      headers: { Accept: "text/html" },
    }).then((response) => response.text());
    const connectedToken = readSandboxConfigValue(connectedHtml, "token");
    const connectedPull = await fetch(`${sandbox.url}/app-api/kv/pull`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connectedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cookie: null }),
    }).then((response) => response.json());
    assert.equal(connectedPull.cookie, 17);
    assert.equal(connectedPull.patch[1].key, "remote");
    assert.equal(remoteRequests, 2);
    assert.equal(refreshRequests, 2);
    assert.equal(mintRequests, 2);
  } finally {
    if (previousConfigDirectory === undefined)
      delete process.env.MAYPOP_CONFIG_DIR;
    else process.env.MAYPOP_CONFIG_DIR = previousConfigDirectory;
    if (previousProfile === undefined) delete process.env.MAYPOP_PROFILE;
    else process.env.MAYPOP_PROFILE = previousProfile;
    await sandbox?.close().catch(() => {});
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
