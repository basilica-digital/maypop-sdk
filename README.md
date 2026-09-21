# maypop-sdk

The framework-neutral browser SDK for apps running on Maypop. It exposes the
same object and capabilities as the hosted `/sdk/v1.js` script: identity, KV,
Drive, AI, integrations, multiplayer, notifications, and the other APIs in the
typed `Maypop` contract.

## Install

```sh
pnpm add maypop-sdk
```

Import the SDK from browser code and wait for the Maypop host before using a
capability:

```ts
import { maypop } from "maypop-sdk";

await maypop.ready();
const todos = await maypop.kv.list({ prefix: "todo/" });
```

The default and named exports are the exact same object as `window.maypop`, so
framework code and scripts can interoperate without adapters:

```ts
import maypop, { type Maypop } from "maypop-sdk";

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
} from "maypop-sdk/react";

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
import { MaypopProvider } from "maypop-sdk/react";

<MaypopProvider client={sandboxClient}>
  <App />
</MaypopProvider>
```

## Local sandbox hosts

### Vite

Add the Maypop plugin to an existing Vite configuration:

```ts
import { maypop } from "maypop-sdk/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [maypop()],
});
```

### Rsbuild

Add the equivalent plugin to an Rsbuild configuration:

```ts
import { defineConfig } from "@rsbuild/core";
import { maypop } from "maypop-sdk/rsbuild";

export default defineConfig({
  plugins: [maypop()],
});
```

### Next.js

Wrap a Next.js configuration. The wrapper adds its sandbox proxy only to
`next dev`; builds and production servers keep the original configuration:

```ts
import { withMaypop } from "maypop-sdk/next";

export default withMaypop({
  output: "export",
});
```

The framework's normal development command then serves its URL as a Maypop host
with the application inside it, including when a routed application opens or
refreshes a deep URL. The app uses the production SDK handshake, iframe
permissions, and API shapes. Shared KV state persists to `.maypop/kv.json`,
while Drive metadata and bytes persist under `.maypop/drive/`. Add `.maypop/`
to the app's `.gitignore`.

The Next.js binding also adds the machine's active network addresses to
`allowedDevOrigins`, so opening the development server from another device on
the LAN loads and hydrates its client scripts. Any configured entries are
preserved.

Identity, KV, and Drive are available locally. Their capability scopes are
reported through `maypop.user.scopes`; APIs that need another capability fail
with `maypop/unsupported` when they reach the local host. Host actions such as
sharing or opening another app fail immediately with the same code instead of
waiting for a timeout.

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

The bindings only affect framework development servers. Production builds
remain ordinary app bundles. `maypop init` records the matching build adapter
in `maypop.toml`, and `maypop publish` builds and uploads its static output.

## Hosted script compatibility

Existing apps can keep loading the global build:

```html
<script src="https://api.dev.maypop.ai/sdk/v1.js"></script>
```

Importing `maypop-sdk` installs that same build from the package instead. Both
forms use the same host handshake and backend API, and both expose
`window.maypop`. Do not use both forms in one app; the runtime is idempotent,
but one is enough.

This package is the guest side of the Maypop protocol. Outside Maypop,
`maypop.ready()` waits for a compatible host. A future local sandbox command
can provide that host protocol and local capability services without requiring
applications to change their SDK imports.

## Backend artifacts

The published tarball also contains the generated host scripts, lazy capability
chunks, shell document, contracts, and Iroh WebAssembly runtime under `dist/`.
The Maypop backend pins an exact package version and embeds these files into its
binary, so a backend build never depends on the SDK repository's moving branch.

The source contract and runtime are available through `maypop-sdk/source/v1`
and `maypop-sdk/source/runtime` for Maypop's own contract tooling. Application
code should use the public entry points shown above.

## Development

All maintained SDK code lives in `src/` as TypeScript. `pnpm build` compiles the
npm entry, hosted global, lazy capability chunks, shell host, injected scripts,
service worker, declarations, and backend artifacts into the ignored `dist/`
directory. Generated JavaScript is never a source of truth and should not be
edited directly.

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
