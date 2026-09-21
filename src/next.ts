import { hostname, networkInterfaces } from "node:os";
import type { NextConfig } from "next";

import {
  SANDBOX_APP_QUERY,
  createMaypopSandboxServer,
  type MaypopSandboxServer,
} from "./sandbox/runtime.js";

/** Options for the local Maypop Next.js development host. */
export interface MaypopNextOptions {
  /** Storage directory, relative to the Next.js project root. Defaults to `.maypop`. */
  dataDirectory?: string;
  /** Viewer name exposed through `maypop.user`. Defaults to `Developer`. */
  username?: string;
}

type RouteCondition = {
  type: "header" | "query";
  key: string;
  value?: string;
};

type Rewrite = {
  source: string;
  destination: string;
  basePath?: false;
  has?: RouteCondition[];
  missing?: RouteCondition[];
};

type RewriteSet = {
  beforeFiles: Rewrite[];
  afterFiles: Rewrite[];
  fallback: Rewrite[];
};

type MaypopNextGlobal = typeof globalThis & {
  __maypopNextSandboxes?: Map<string, Promise<MaypopSandboxServer>>;
};

const NEXT_KV_PULL_INTERVAL_MS = 1_000;
const maypopNextGlobal = globalThis as MaypopNextGlobal;
const nextSandboxes =
  maypopNextGlobal.__maypopNextSandboxes ??
  (maypopNextGlobal.__maypopNextSandboxes = new Map());

function sandboxKey(root: string, options: MaypopNextOptions): string {
  return JSON.stringify([
    root,
    options.dataDirectory ?? ".maypop",
    options.username ?? "Developer",
  ]);
}

function getNextSandbox(
  root: string,
  options: MaypopNextOptions,
): Promise<MaypopSandboxServer> {
  const key = sandboxKey(root, options);
  const existing = nextSandboxes.get(key);
  if (existing) return existing;

  // Next's development rewrite proxy buffers an open SSE response. Polling is
  // a fallback for its sandbox only; hosted Maypop, Vite, and Rsbuild remain
  // poke-driven.
  const sandbox = createMaypopSandboxServer(root, {
    ...options,
    kvPullIntervalMs: NEXT_KV_PULL_INTERVAL_MS,
  }).catch((error) => {
    nextSandboxes.delete(key);
    throw error;
  });
  nextSandboxes.set(key, sandbox);
  return sandbox;
}

function sandboxRewrites(origin: string): Rewrite[] {
  const proxy = (source: string, destination = source): Rewrite => ({
    source,
    destination: `${origin}${destination}`,
    basePath: false,
  });

  return [
    proxy("/app-api/:path*"),
    proxy("/_maypop/:path*"),
    proxy("/sdk/kv-v1.js"),
    proxy("/_maypop-sw.js"),
    proxy("/_maypop/upload/:path*"),
    proxy("/_maypop/drive/:path*"),
    {
      source: "/:path*",
      destination: `${origin}/:path*`,
      basePath: false,
      has: [{ type: "header", key: "accept", value: ".*text/html.*" }],
      missing: [
        { type: "query", key: SANDBOX_APP_QUERY },
        { type: "header", key: "sec-fetch-dest", value: "iframe" },
      ],
    },
  ];
}

function mergeRewrites(
  maypopRewrites: Rewrite[],
  existing: Rewrite[] | Partial<RewriteSet> | undefined,
): RewriteSet {
  if (Array.isArray(existing)) {
    return {
      beforeFiles: maypopRewrites,
      afterFiles: existing,
      fallback: [],
    };
  }

  return {
    beforeFiles: [...maypopRewrites, ...(existing?.beforeFiles ?? [])],
    afterFiles: existing?.afterFiles ?? [],
    fallback: existing?.fallback ?? [],
  };
}

function allowedDevOrigins(configured: string[] | undefined): string[] {
  const origins = new Set(configured);

  // Next protects its internal development assets by hostname. Limit the
  // automatic allowance to addresses assigned to this machine instead of
  // opening the whole private network with wildcard patterns.
  origins.add(hostname());
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) origins.add(address.address);
    }
  }

  return [...origins].filter(Boolean);
}

/** Add a Maypop development host configured by `.maypop/dev.json`. */
export function withMaypop(
  config: NextConfig = {},
  options: MaypopNextOptions = {},
): NextConfig {
  if (process.env.NODE_ENV !== "development") return config;

  const existingRewrites = config.rewrites;
  // Next.js rejects rewrites when static export is active, even though the
  // export setting only matters for production builds.
  const developmentConfig =
    config.output === "export"
      ? (({ output: _output, ...remainingConfig }) => remainingConfig)(config)
      : config;
  return {
    ...developmentConfig,
    allowedDevOrigins: allowedDevOrigins(config.allowedDevOrigins),
    async rewrites() {
      const sandbox = await getNextSandbox(process.cwd(), options);
      const existing = (await existingRewrites?.()) as
        | Rewrite[]
        | Partial<RewriteSet>
        | undefined;
      return mergeRewrites(sandboxRewrites(sandbox.origin), existing);
    },
  };
}

export default withMaypop;
