import type { Plugin } from "vite";

import {
  createMaypopSandboxRuntime,
  sandboxMarkerCleanupScript,
  sendMaypopSandboxError,
} from "./sandbox/runtime.js";

/** Options for the local Maypop Vite development host. */
export interface MaypopVitePluginOptions {
  /** Storage directory, relative to Vite's project root. Defaults to `.maypop`. */
  dataDirectory?: string;
  /** Viewer name exposed through `maypop.user`. Defaults to `Developer`. */
  username?: string;
}

/** Wrap Vite's dev server in a Maypop host configured by `.maypop/dev.json`. */
export function maypop(options: MaypopVitePluginOptions = {}): Plugin {
  return {
    name: "maypop-sandbox",
    apply: "serve",
    enforce: "pre",
    // The host and app share a URL. The marker bypasses the host for the
    // iframe navigation; removing it before app code runs keeps routing clean.
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          {
            tag: "script",
            injectTo: "head-prepend",
            children: sandboxMarkerCleanupScript(),
          },
        ];
      },
    },
    async configureServer(server) {
      const runtime = await createMaypopSandboxRuntime(
        server.config.root,
        options,
      );
      server.middlewares.use((request, response, next) => {
        void runtime.handle(request, response, next).catch((error) => {
          sendMaypopSandboxError(response, error);
        });
      });
      server.httpServer?.once("close", () => runtime.close());

      return () => {
        server.config.logger.info(
          `  Maypop sandbox data: ${runtime.dataDirectory}`,
        );
      };
    },
  };
}

export default maypop;
