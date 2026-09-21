import type { RsbuildPlugin } from "@rsbuild/core";

import {
  createMaypopSandboxRuntime,
  sandboxMarkerCleanupScript,
  sendMaypopSandboxError,
  type MaypopSandboxRuntime,
} from "./sandbox/runtime.js";

/** Options for the local Maypop Rsbuild host. */
export interface MaypopRsbuildPluginOptions {
  /** Storage directory, relative to Rsbuild's project root. Defaults to `.maypop`. */
  dataDirectory?: string;
  /** Viewer name exposed through `maypop.user`. Defaults to `Developer`. */
  username?: string;
}

function injectMarkerCleanup(html: string): string {
  const script = `<script>${sandboxMarkerCleanupScript()}</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) return `${script}${html}`;
  const offset = (head.index ?? 0) + head[0].length;
  return `${html.slice(0, offset)}${script}${html.slice(offset)}`;
}

/** Wrap Rsbuild's dev server in a local Maypop host with persistent KV and Drive. */
export function maypop(
  options: MaypopRsbuildPluginOptions = {},
): RsbuildPlugin {
  let runtime: MaypopSandboxRuntime | undefined;

  return {
    name: "maypop-sandbox",
    apply: "serve",
    setup(api) {
      api.modifyHTML(injectMarkerCleanup);
      api.onBeforeStartDevServer(async ({ server }) => {
        runtime = await createMaypopSandboxRuntime(
          api.context.rootPath,
          options,
        );
        server.middlewares.use((request, response, next) => {
          void runtime?.handle(request, response, next).catch((error) => {
            sendMaypopSandboxError(response, error);
          });
        });
      });
      api.onCloseDevServer(() => {
        runtime?.close();
        runtime = undefined;
      });
    },
  };
}

export default maypop;
