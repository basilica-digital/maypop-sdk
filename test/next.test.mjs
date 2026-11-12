import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { withMaypop } from "@basilica-digital/maypop-sdk/next";

const execFileAsync = promisify(execFile);

function readSandboxConfigValue(html, name) {
  const match = html.match(new RegExp(`"${name}":"([^"]+)"`));
  assert.ok(match, `sandbox HTML exposes ${name}`);
  return match[1];
}

test("the Next.js binding composes rewrites around a private sandbox server", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-next-test-"));
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  try {
    const config = withMaypop(
      {
        allowedDevOrigins: ["preview.example.test"],
        output: "export",
        async rewrites() {
          return [{ source: "/legacy", destination: "/modern" }];
        },
      },
      { dataDirectory: join(root, ".maypop") },
    );
    assert.equal(config.output, undefined);
    assert.ok(config.allowedDevOrigins.includes("preview.example.test"));
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (!address.internal) {
          assert.ok(
            config.allowedDevOrigins.includes(address.address),
            `${address.address} is allowed for LAN development`,
          );
        }
      }
    }
    const rewrites = await config.rewrites();
    assert.equal(rewrites.afterFiles[0].source, "/legacy");
    assert.ok(
      rewrites.beforeFiles.some((rewrite) => rewrite.source === "/_maypop/:path*"),
    );

    const documentRewrite = rewrites.beforeFiles.at(-1);
    assert.equal(documentRewrite.source, "/:path*");
    assert.deepEqual(documentRewrite.missing, [
      { type: "query", key: "__maypop_app" },
      { type: "header", key: "sec-fetch-dest", value: "iframe" },
    ]);

    const sandboxUrl = new URL(
      documentRewrite.destination.replace(":path*", "todos/42"),
    );
    const hostHtml = await fetch(sandboxUrl, {
      headers: { Accept: "text/html" },
    }).then((response) => response.text());
    assert.match(hostHtml, /Maypop sandbox/);
    assert.match(hostHtml, /"kvPullIntervalMs":1000/);
    const token = readSandboxConfigValue(hostHtml, "token");

    const identity = await fetch(new URL("/app-api/me", sandboxUrl), {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(identity.status, 200);
    assert.equal((await identity.json()).username, "Developer");

    const agentRuntime = await fetch(new URL("/sdk/agent-v1.js", sandboxUrl));
    assert.equal(agentRuntime.status, 200);
    assert.match(agentRuntime.headers.get("content-type"), /javascript/);
    await agentRuntime.arrayBuffer();

    const multiplayerWasm = await fetch(
      new URL("/sdk/iroh-v1_bg.wasm", sandboxUrl),
    );
    assert.equal(multiplayerWasm.status, 200);
    assert.equal(multiplayerWasm.headers.get("content-type"), "application/wasm");
    await multiplayerWasm.arrayBuffer();
  } finally {
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
    await rm(root, { recursive: true, force: true });
  }
});

// Guards: a document Next serves itself (the app inside the host, or one
// opened in a window of its own) going out without the policy the sandbox
// host sends, or with a project's own, however the project spells the header.
test("Next serves its own documents with the app permissions policy", async () => {
  // Inside the package, so the project resolves next and react.
  const root = await mkdtemp(join(process.cwd(), ".next-test-"));

  try {
    await mkdir(join(root, "pages"));
    await writeFile(
      join(root, "pages/index.js"),
      "export default function Page() { return null; }\n",
    );
    await writeFile(
      join(root, "next.config.mjs"),
      `import { withMaypop } from "@basilica-digital/maypop-sdk/next";
export default withMaypop(
  {
    async headers() {
      return [
        {
          source: "/:path*",
          headers: [{ key: "Permissions-Policy", value: "camera=()" }],
        },
        {
          source: "/:path*",
          headers: [
            { key: "permissions-policy", value: "display-capture=*" },
            { key: "X-Project", value: "kept" },
          ],
        },
      ];
    },
  },
  { dataDirectory: ${JSON.stringify(join(root, ".maypop"))} },
);
`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(process.cwd(), "test/next-dev-headers.mjs"),
        root,
        "/?__maypop_app=1",
        "/missing?__maypop_app=1",
      ],
      { env: { ...process.env, NODE_ENV: "development" }, timeout: 120_000 },
    );
    const results = JSON.parse(stdout.match(/^RESULTS (.*)$/m)[1]);
    assert.equal(results.length, 2);
    for (const { path, headers } of results) {
      assert.equal(
        headers["permissions-policy"],
        "display-capture=(), clipboard-read=(), accelerometer=(), gyroscope=(), magnetometer=()",
        path,
      );
      assert.equal(headers["x-project"], "kept", path);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Next.js binding leaves production configurations untouched", () => {
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const config = { output: "export" };

  try {
    assert.equal(withMaypop(config), config);
  } finally {
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
});
