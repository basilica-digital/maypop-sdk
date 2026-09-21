import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";

import { maypop } from "maypop-sdk/vite";

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

    const unsupported = await fetch(`${sandbox.url}/app-api/members`, {
      headers: authorization,
    });
    assert.equal(unsupported.status, 501);
    assert.deepEqual(await unsupported.json(), {
      error: "The local Maypop sandbox does not implement members yet.",
      code: "sandbox_capability_unavailable",
    });

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
