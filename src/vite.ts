import type { IncomingMessage, ServerResponse } from "node:http";
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

interface MaypopViteDevServer {
  config: {
    root: string;
    logger: { info(message: string): void };
  };
  middlewares: {
    use(
      handler: (
        request: IncomingMessage,
        response: ServerResponse,
        next: () => void,
      ) => void,
    ): void;
  };
  httpServer?: {
    once(event: "close", listener: () => void): unknown;
  } | null;
}

/**
 * Vite-compatible plugin shape that does not expose the SDK's installed Vite
 * version in consumer type checking.
 */
export interface MaypopVitePlugin {
  readonly name: "maypop-sandbox";
  readonly apply: "serve";
  readonly enforce: "pre";
  readonly transformIndexHtml: {
    readonly order: "pre";
    handler(): Array<{
      tag: "script";
      injectTo: "head-prepend";
      children: string;
    }>;
  };
  configureServer(server: MaypopViteDevServer): Promise<() => void>;
}

/** Wrap Vite's dev server in a Maypop host configured by `.maypop/dev.json`. */
export function maypop(options: MaypopVitePluginOptions = {}): MaypopVitePlugin {
  const plugin = {
    name: "maypop-sandbox" as const,
    apply: "serve",
    enforce: "pre",
    // The host and app share a URL. The marker bypasses the host for the
    // iframe navigation; removing it before app code runs keeps routing clean.
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          {
            tag: "script" as const,
            injectTo: "head-prepend",
            children: sandboxMarkerCleanupScript(),
          },
        ];
      },
    },
    async configureServer(server: MaypopViteDevServer) {
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
  } satisfies Plugin;

  return plugin;
}

export default maypop;
