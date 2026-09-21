import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sdkDirectory = fileURLToPath(new URL("..", import.meta.url));

test("the package declaration retains the complete public SDK type", async () => {
  const declaration = await readFile(
    new URL("../dist/index.d.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    declaration,
    /import type \{ MaypopSdk \} from "\.\/v1\.js";/,
  );
  assert.match(declaration, /export type Maypop = MaypopSdk;/);

  const reactDeclaration = await readFile(
    new URL("../dist/react.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(reactDeclaration, /useMaypopKV<T>/);
  assert.doesNotMatch(reactDeclaration, /declare class (Kv|Session)Store/);

  const viteDeclaration = await readFile(
    new URL("../dist/vite.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(viteDeclaration, /function maypop\(/);
  assert.match(viteDeclaration, /dataDirectory\?: string/);
  assert.doesNotMatch(viteDeclaration, /sandbox\/runtime/);

  const nextDeclaration = await readFile(
    new URL("../dist/next.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(nextDeclaration, /function withMaypop\(/);
  assert.doesNotMatch(nextDeclaration, /sandbox\/runtime/);

  const rsbuildDeclaration = await readFile(
    new URL("../dist/rsbuild.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(rsbuildDeclaration, /function maypop\(/);
  assert.doesNotMatch(rsbuildDeclaration, /sandbox\/runtime/);
});

test("the package export is the hosted window.maypop object", async () => {
  const window = {
    addEventListener() {},
  };
  window.parent = window;

  Object.defineProperties(globalThis, {
    document: {
      configurable: true,
      value: {
        addEventListener() {},
        documentElement: { dataset: {}, style: {} },
      },
    },
    location: { configurable: true, value: { hash: "" } },
    navigator: { configurable: true, value: {} },
    window: { configurable: true, value: window },
  });

  const module = await import("@basilica-digital/maypop-sdk");

  assert.equal(module.default, window.maypop);
  assert.equal(module.maypop, window.maypop);
  assert.equal(module.getMaypop(), window.maypop);
  assert.equal(Object.isFrozen(module.maypop), true);
  assert.equal(typeof module.maypop.ready, "function");
  assert.equal(typeof module.maypop.kv.subscribe, "function");
  assert.equal(typeof module.maypop.drive.write, "function");
  assert.equal(typeof module.maypop.ai.chat, "function");
});

test("host-provided chunks remain runtime imports for framework bundlers", async () => {
  const bundle = await readFile(
    new URL("../dist/index.js", import.meta.url),
    "utf8",
  );
  assert.equal(
    bundle.match(/webpackIgnore: true/g)?.length,
    3,
    "webpack must not resolve host-provided modules",
  );
  assert.equal(
    bundle.match(/turbopackIgnore: true/g)?.length,
    3,
    "Turbopack must not resolve host-provided modules",
  );
});

test("the release contains the backend's immutable runtime artifacts", async () => {
  const [sourceShell, builtShell, irohModule, irohWasm] = await Promise.all([
    readFile(new URL("../shell.html", import.meta.url)),
    readFile(new URL("../dist/shell.html", import.meta.url)),
    readFile(new URL("../dist/iroh-v1.js", import.meta.url)),
    readFile(new URL("../dist/iroh-v1_bg.wasm", import.meta.url)),
  ]);

  assert.deepEqual(builtShell, sourceShell);
  assert.ok(irohModule.length > 0);
  assert.deepEqual(irohWasm.subarray(0, 4), Buffer.from("\0asm"));
});

test("server rendering can import the package but cannot use browser capabilities", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { maypop } from "@basilica-digital/maypop-sdk";
        try {
          maypop.ready;
          process.exitCode = 1;
        } catch (error) {
          if (!String(error.message).includes("available in the browser")) {
            throw error;
          }
        }
      `,
    ],
    { cwd: sdkDirectory, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
});
