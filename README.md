# maypop-sdk

The framework-neutral browser SDK for apps running on Maypop. It exposes the
same object and capabilities as the hosted `/sdk/v1.js` script: identity, KV,
Drive, AI, integrations, multiplayer, notifications, and the other APIs in the
typed `Maypop` contract.

## Install

```sh
pnpm add @basilica-digital/maypop-sdk
```

Import the SDK from browser code and wait for the Maypop host before using a
capability:

```ts
import { maypop } from "@basilica-digital/maypop-sdk";

await maypop.ready();
const todos = await maypop.kv.list({ prefix: "todo/" });
```

The default and named exports are the exact same object as `window.maypop`, so
framework code and scripts can interoperate without adapters:

```ts
import maypop, { type Maypop } from "@basilica-digital/maypop-sdk";

function currentUser(sdk: Maypop = maypop) {
  return sdk.user;
}
```

The module is safe to import while a framework renders on the server. Accessing
the SDK there still throws because capabilities belong to the browser-hosted app
session. Call `getMaypop()` from browser-only code when an SSR framework needs
to defer access explicitly.

## React

React apps can subscribe to Maypop state without manually coordinating the host
handshake or effect cleanup:

```tsx
import {
  useMaypopKV,
  useMaypopMode,
  useMaypopSession,
} from "@basilica-digital/maypop-sdk/react";

export function Counter() {
  const session = useMaypopSession();
  const mode = useMaypopMode();
  const count = useMaypopKV("counter", 0);

  if (session.status === "connecting") return <p>Connecting…</p>;
  if (session.status === "error") return <p>{session.error.message}</p>;

  return (
    <button
      disabled={mode === "read-only" || count.isMutating}
      onClick={() => count.setValue(count.value + 1)}
    >
      {count.value}
    </button>
  );
}
```

The hooks use the hosted SDK automatically. `MaypopProvider` is only needed to
inject another client in a test or future local sandbox host:

```tsx
import { MaypopProvider } from "@basilica-digital/maypop-sdk/react";

<MaypopProvider client={sandboxClient}>
  <App />
</MaypopProvider>
```

## Local development hosts

### Vite

Add the Maypop plugin to an existing Vite configuration:

```ts
import { maypop } from "@basilica-digital/maypop-sdk/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [maypop()],
});
```

### Rsbuild

Add the equivalent plugin to an Rsbuild configuration:

```ts
import { defineConfig } from "@rsbuild/core";
import { maypop } from "@basilica-digital/maypop-sdk/rsbuild";

export default defineConfig({
  plugins: [maypop()],
});
```

### Next.js

Wrap a Next.js configuration. The wrapper adds its sandbox proxy only to
`next dev`; builds and production servers keep the original configuration:

```ts
import { withMaypop } from "@basilica-digital/maypop-sdk/next";

export default withMaypop({
  output: "export",
});
```

The framework's normal development command then serves its URL as a Maypop host
with the application inside it, including when a routed application opens or
refreshes a deep URL. The app uses the production SDK handshake, iframe
permissions, and API shapes. Shared KV state persists to `.maypop/kv.json`,
while Drive metadata and bytes persist under `.maypop/drive/`.

The Next.js binding also adds the machine's active network addresses to
`allowedDevOrigins`, so opening the development server from another device on
the LAN loads and hydrates its client scripts. Any configured entries are
preserved.

Identity, members, KV, Drive, and a notification outbox are available locally.
Their capability scopes are reported through `maypop.user.scopes`; APIs that
need another capability fail with `maypop/unsupported` when they reach the
local host. Host actions such as sharing or opening another app fail
immediately with the same code instead of waiting for a timeout.

`maypop.notify()` is captured by default rather than delivered. Open the
Maypop badge in the development host, or visit `/_maypop/notifications`, to
inspect the requested and resolved recipients, title, body, and deep link.
Captured calls persist in `.maypop/notifications.json`.

### Authenticated development

Create `.maypop/dev.json` to opt this machine into authenticated capabilities.
Do not commit the file: it selects a developer account and can enable access to
real app data or billable AI calls.

Hybrid mode keeps KV and Drive local while forwarding an explicit set of
read-only or non-data capabilities through the account authenticated by
`maypop auth`:

```json
{
  "mode": "hybrid",
  "profile": "dev",
  "remoteCapabilities": ["ai", "members", "link"],
  "notifications": "inspect"
}
```

`ai` includes chat completions, streaming, images, video, audio, and
transcription. These calls use the selected account's real allowance and can
consume credits. `members` reads the real app roster, while `link` enables
server-side URL unfurling. KV and Drive remain local, and notifications remain
in the inspector.

Connected mode skips local KV/Drive initialization and sends the entire app API
surface to the real app:

```json
{
  "mode": "connected",
  "profile": "dev",
  "notifications": "inspect"
}
```

The project must already be connected by `maypop init`, and the selected CLI
profile must be authenticated and have access to that app. Omit `profile` to
use the normal CLI selection rules, including `MAYPOP_PROFILE` and the profile
whose API URL matches the repository. The development host asks the CLI for a
short-lived app-scoped session; the saved CLI credential and refresh token are
never exposed to application code.

Real notification delivery requires connected mode and a second explicit
opt-in:

```json
{
  "mode": "connected",
  "notifications": "live"
}
```

Use `"notifications": "disabled"` to remove notification permission entirely.
The default is `"inspect"` in every development mode.

The local bearer token is random for every server run, and a lock prevents two
development servers from writing the same data directory. To use a different
directory or viewer name:

```ts
maypop({
  dataDirectory: ".maypop/alice",
  username: "Alice",
});
```

The local host is development tooling, not a security boundary. Keep the
development server bound to a trusted interface unless the project itself is
safe to expose.

Ignore generated development state without hiding a committed KV policy:

```gitignore
.maypop/.lock
.maypop/config.json
.maypop/dev.json
.maypop/drive/
.maypop/kv.json
.maypop/notifications.json
```

The bindings only affect framework development servers. Production builds
remain ordinary app bundles. `maypop init` records the matching build adapter
in `maypop.toml`, and `maypop publish` builds and uploads its static output.

## Hosted script compatibility

Existing apps can keep loading the global build:

```html
<script src="https://api.dev.maypop.ai/sdk/v1.js"></script>
```

Importing `@basilica-digital/maypop-sdk` installs that same build from the package instead. Both
forms use the same host handshake and backend API, and both expose
`window.maypop`. Do not use both forms in one app; the runtime is idempotent,
but one is enough.

This package is the guest side of the Maypop protocol. Outside Maypop,
`maypop.ready()` waits for a compatible host. The framework integrations above
provide that host protocol without requiring applications to change their SDK
imports.

## Backend artifacts

The published tarball also contains the generated host scripts, lazy capability
chunks, shell document, contracts, and Iroh WebAssembly runtime under `dist/`.
The Maypop backend pins an exact package version and embeds these files into its
binary, so a backend build never depends on the SDK repository's moving branch.

The source contract and runtime are available through
`@basilica-digital/maypop-sdk/source/v1` and
`@basilica-digital/maypop-sdk/source/runtime` for Maypop's own contract tooling. Application
code should use the public entry points shown above.

## Development

All maintained SDK code lives in `src/` as TypeScript. `pnpm build` compiles the
npm entry, hosted global, lazy capability chunks, shell host, injected scripts,
service worker, declarations, and backend artifacts into the ignored `dist/`
directory. Generated JavaScript is never a source of truth and should not be
edited directly.

The Iroh runtime lives in `iroh/`; its generated bindings and WebAssembly are
committed under `iroh/prebuilt/` so ordinary package builds do not require a
Rust/Wasm toolchain. After changing `iroh/src`, install the
`wasm32-unknown-unknown` target, `wasm-bindgen-cli` matching the crate's pinned
version, and Binaryen's `wasm-opt`, then run:

```sh
just build-iroh
```

## Release

Versions follow SemVer and tags use the matching `vX.Y.Z` form. Before tagging,
update `package.json` and the lockfile, then run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm pack
```

Pushing the matching tag runs the npm publication workflow. The first release
must be published by an npm owner; after that, configure this repository as the
package's trusted publisher for `.github/workflows/release.yml`.
