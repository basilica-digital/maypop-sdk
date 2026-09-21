// Builds every executable SDK artifact from the TypeScript sources in src/.
//
// Usage: `node build.mjs [outDir]`
//   - no arg  -> writes to ./dist (the npm package output)
//   - <outDir> -> writes there (build.rs passes Cargo's OUT_DIR)
//
// Output:
//   - index.js (+ .d.ts): the npm module entry.
//   - react.js (+ .d.ts): React subscriptions and hooks.
//   - vite/rsbuild/next.js (+ .d.ts): local sandbox-host bindings.
//   - v1.js (+ .d.ts): the hosted global runtime and public contract.
//   - agent-v1.js (+ .d.ts): the pi agent runtime.
//   - kv-v1.js: the Replicache-backed kv engine (no public .d.ts; internal —
//     the kv surface lives in v1.d.ts).
//   - host/injected/service-worker scripts embedded by the backend.
//   - shell.html and the prebuilt Iroh transport consumed by the backend.

import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ? process.argv[2] : join(here, "dist");
mkdirSync(outDir, { recursive: true });

// pi-ai vendors a model SDK per provider (Anthropic, Bedrock, Google, Mistral,
// OpenAI). We drive the model exclusively through the openai-completions
// provider, so every other vendor SDK — all Node-coupled and heavy — is dead
// weight. Stub them to empty modules so they never enter the browser bundle.
const STUBBED = [
  "@anthropic-ai/sdk",
  "@aws-sdk/client-bedrock-runtime",
  "@smithy/node-http-handler",
  "@google/genai",
  "@mistralai/mistralai",
  "http-proxy-agent",
  "https-proxy-agent",
];

const stubPlugin = {
  name: "stub-pi-vendors",
  setup(build) {
    // pi-ai's provider registry side-effect-imports every provider (the file is
    // `register-builtins.js`, minified to `n.js` in some builds). We call the
    // openai-completions provider directly and never touch the registry, so
    // stub it out — this drops all the other provider modules (and the heavy
    // vendor SDKs they import) and keeps the output a single ESM file.
    build.onResolve({ filter: /providers\/(register-builtins|n)\.js$/ }, (args) => ({
      path: args.path,
      namespace: "pi-empty",
    }));
    build.onLoad({ filter: /.*/, namespace: "pi-empty" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));

    // Belt-and-suspenders: if any kept module still references a vendor SDK,
    // resolve it to a callable Proxy so named imports don't fail the build. The
    // openai-completions path never executes these, so the no-ops are inert.
    const escaped = STUBBED.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const vendorFilter = new RegExp(`^(?:${escaped.join("|")})(?:/.*)?$`);
    build.onResolve({ filter: vendorFilter }, (args) => ({
      path: args.path,
      namespace: "pi-vendor",
    }));
    build.onLoad({ filter: /.*/, namespace: "pi-vendor" }, () => ({
      // CJS so esbuild resolves named imports as runtime property reads on the
      // Proxy rather than statically — any symbol becomes an inert no-op.
      contents:
        "const stub = new Proxy(function(){}, { get: () => stub, apply: () => stub });\nmodule.exports = stub;",
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: {
    index: join(here, "src/index.ts"),
    v1: join(here, "src/runtime.ts"),
    "agent-v1": join(here, "src/agent/index.ts"),
    // The kv engine — Replicache bundled with a custom puller/pusher. A
    // separate lazily-loaded chunk (like agent-v1) so the ~100KB Replicache
    // runtime only downloads for apps that sync, never in preview.
    "kv-v1": join(here, "src/kv/index.ts"),
    "activity-tracker": join(here, "src/activity-tracker.ts"),
    "ambient-palette": join(here, "src/ambient-palette.ts"),
    "app-cache-sw": join(here, "src/app-cache-sw.ts"),
    host: join(here, "src/host.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  outdir: outDir,
  plugins: [stubPlugin],
});

// The capability chunks are served by the Maypop host at runtime. Framework
// bundlers must leave those URL imports alone instead of trying to resolve a
// build-time module graph from the dynamic API base.
for (const name of ["index.js", "v1.js"]) {
  const path = join(outDir, name);
  const source = readFileSync(path, "utf8");
  const imports = source.match(/\bimport\(/g) ?? [];
  if (imports.length !== 3) {
    throw new Error(`${name} contained ${imports.length} runtime imports; expected 3`);
  }
  writeFileSync(
    path,
    source.replaceAll(
      "import(",
      "import(/* webpackIgnore: true */ /* turbopackIgnore: true */ ",
    ),
  );
}

// Keep React itself and the core SDK entry outside the adapter bundle. This
// makes React an optional peer for core consumers and prevents two SDK runtime
// copies when an app imports both package entry points.
await esbuild.build({
  entryPoints: { react: join(here, "src/react.ts") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  outdir: outDir,
  external: ["react", "./index.js"],
});

await esbuild.build({
  entryPoints: {
    next: join(here, "src/next.ts"),
    rsbuild: join(here, "src/rsbuild.ts"),
    vite: join(here, "src/vite.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  minify: true,
  legalComments: "none",
  outdir: outDir,
  external: ["@rsbuild/core", "next", "vite"],
});

// Emit declarations from the same TypeScript graph as the JavaScript build.
// The public surfaces intentionally use only their own types, so the selected
// declaration files are self-contained in the output directory.
const tmp = join(outDir, ".dts-tmp");
rmSync(tmp, { recursive: true, force: true });
execFileSync(
  join(here, "node_modules", ".bin", "tsc"),
  ["--emitDeclarationOnly", "--outDir", tmp],
  { cwd: here, stdio: "inherit" },
);
copyFileSync(join(tmp, "agent", "index.d.ts"), join(outDir, "agent-v1.d.ts"));
const rawIndexDeclaration = readFileSync(join(tmp, "index.d.ts"), "utf8");
const indexDeclaration = rawIndexDeclaration.replace('import "./runtime.js";\n', "");
if (indexDeclaration === rawIndexDeclaration) {
  throw new Error("generated index.d.ts did not contain the bundled runtime import");
}
writeFileSync(join(outDir, "index.d.ts"), indexDeclaration);
copyFileSync(join(tmp, "react.d.ts"), join(outDir, "react.d.ts"));
copyFileSync(join(tmp, "next.d.ts"), join(outDir, "next.d.ts"));
copyFileSync(join(tmp, "rsbuild.d.ts"), join(outDir, "rsbuild.d.ts"));
copyFileSync(join(tmp, "vite.d.ts"), join(outDir, "vite.d.ts"));
copyFileSync(join(tmp, "v1.d.ts"), join(outDir, "v1.d.ts"));
rmSync(tmp, { recursive: true, force: true });

copyFileSync(join(here, "shell.html"), join(outDir, "shell.html"));
copyFileSync(
  join(here, "iroh", "prebuilt", "iroh-v1.js"),
  join(outDir, "iroh-v1.js"),
);
copyFileSync(
  join(here, "iroh", "prebuilt", "iroh-v1_bg.wasm"),
  join(outDir, "iroh-v1_bg.wasm"),
);

console.log(`built TypeScript SDK artifacts -> ${outDir}`);
