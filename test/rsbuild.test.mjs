import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createRsbuild } from "@rsbuild/core";
import { maypop } from "@basilica-digital/maypop-sdk/rsbuild";

function readSandboxConfigValue(html, name) {
  const match = html.match(new RegExp(`"${name}":"([^"]+)"`));
  assert.ok(match, `sandbox HTML exposes ${name}`);
  return match[1];
}

test("the Rsbuild plugin wraps the real development server", async () => {
  const root = await mkdtemp(join(tmpdir(), "maypop-rsbuild-test-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src/index.js"),
    'document.body.innerHTML = "Rsbuild app";',
  );

  const rsbuild = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      plugins: [maypop()],
      server: { host: "127.0.0.1", port: 0 },
      source: { entry: { index: "./src/index.js" } },
    },
  });
  const started = await rsbuild.startDevServer({ getPortSilently: true });
  const url = `http://127.0.0.1:${started.port}`;

  try {
    const hostHtml = await fetch(url, {
      headers: { Accept: "text/html" },
    }).then((response) => response.text());
    assert.match(hostHtml, /Maypop sandbox/);
    const appRequestToken = readSandboxConfigValue(
      hostHtml,
      "appRequestToken",
    );

    const app = await fetch(
      `${url}/?__maypop_app=${encodeURIComponent(appRequestToken)}`,
      { headers: { Accept: "text/html" } },
    );
    const appHtml = await app.text();
    assert.equal(app.status, 200);
    assert.match(appHtml, /history\.replaceState/);
    assert.match(appHtml, /static\/js/);
  } finally {
    await started.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
