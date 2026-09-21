/**
 * maypop.kv — the local-first shared key-value store, backed by Replicache.
 *
 * This is the lazily-loaded engine behind the core SDK's `maypop.kv`. The core
 * (window.maypop, src/runtime.ts) keeps the PUBLIC surface and dynamically imports
 * this chunk on first use, delegating every kv read/write to the
 * {@link KvEngine} returned by {@link createKvEngine}. Kept out of the core
 * bundle so the ~100KB Replicache runtime only downloads for apps that
 * actually sync.
 *
 * The backend's `/app-api/kv/{pull,push,poke}` is the standard Replicache DD31
 * protocol scoped to one kv store, so this is a stock Replicache client driven
 * by a custom puller/pusher that wrap those endpoints with the app session
 * token (which rotates — see the 401→refresh→retry in `request`). No backend
 * change was needed; the previous hand-rolled engine already mimicked this
 * wire format.
 *
 * The public surface this engine feeds (get/set/delete/list/subscribe and the
 * {@link KvEntry} shape) is defined in src/v1.ts and is unchanged — only the
 * implementation moved here.
 */
import { Replicache } from "replicache";
import type {
  Puller,
  PullerResultV1,
  Pusher,
  PusherResult,
  PullRequestV1,
  PushRequestV1,
  ReadTransaction,
  WriteTransaction,
} from "replicache";

// Reserved key prefixes layered on top of kv (see v1.js): multiplayer rooms and
// per-viewer agent chat history. Hidden from generic kv reads so room
// heartbeats and transcripts don't leak into an app's `subscribe("")`. Kept in
// sync with the same constants in v1.js.
const MP_PREFIX = "~mp/";
const CHAT_PREFIX = "~chat/";

// Replicache 15.x no longer performs any license check at runtime (the field is
// vestigial); we pass the same dummy the main app uses purely for parity.
const LICENSE_KEY = "l0000000000000000000000000000000";

/** The stored value behind every kv key — the shape the backend pulls down. */
interface KvStoredValue {
  value: unknown;
  author: string | null;
  updatedAt: string;
}

/** One entry as exposed to apps (mirrors `MaypopKvEntry` in v1.d.ts). */
export interface KvEntry {
  key: string;
  value: unknown;
  author: string | null;
  updatedAt: string;
}

/**
 * Hooks the core SDK injects (it owns the session token + context). Mirrors the
 * agent runtime's `AgentHost` pattern — apps never see this.
 * @internal
 */
export interface KvHost {
  /** Backend origin, e.g. `https://api.maypop.ai`. */
  apiBase: string;
  /**
   * Replicache database name — must be stable per (viewer × app instance) so a
   * reload rehydrates the same local store, and distinct across viewers so they
   * never share an IndexedDB. The core SDK derives it from the app + viewer id.
   */
  dbName: string;
  /** Current app session token (rotates), or null if revoked. */
  getToken: () => string | null;
  /**
   * Ask the host for a fresh token; resolves once it has rotated in (so the
   * caller can retry). Mirrors the core SDK's `freshToken()`.
   */
  refreshToken: () => Promise<void>;
  /**
   * The current viewer's pseudonymous id, stamped as the optimistic `author` on
   * local writes so the optimistic view matches the server's projection.
   */
  getMemberId: () => string | null;
  /** Optional polling fallback when the host cannot stream SSE pokes. */
  pullIntervalMs?: number | null;
}

/**
 * The internal engine the core SDK's `maypop.kv` delegates to on a networked
 * session. Method contracts match the public kv surface in v1.d.ts.
 * @internal
 */
export interface KvEngine {
  /** Expose local data and kick off an initial background sync. */
  start(): Promise<void>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<KvEntry[]>;
  subscribe(prefix: string, cb: (entries: KvEntry[]) => void): () => void;
  /** Pull now — wired to the poke SSE stream by the core SDK. */
  poke(): void;
  /** Tear down (close the Replicache instance). */
  close(): Promise<void>;
}

/**
 * Build a Replicache-backed kv engine for a real (networked) session. The
 * Replicache instance is created eagerly so every method can use it the moment
 * the factory returns; {@link KvEngine.start} only triggers the first pull.
 */
export function createKvEngine(host: KvHost): KvEngine {
  // POST a kv endpoint with the current token, retrying once through a token
  // refresh on a 401 — the app token rotates mid-session and Replicache's
  // puller/pusher must ride the refresh rather than surface a transient auth
  // failure. Mirrors the core SDK's `api()` helper.
  async function request(
    path: string,
    body: unknown,
    retried = false,
  ): Promise<{ status: number; ok: boolean; json: unknown; text: string }> {
    const token = host.getToken();
    if (!token) return { status: 401, ok: false, json: null, text: "no token" };
    const res = await fetch(host.apiBase + "/app-api" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      await host.refreshToken().catch(() => {});
      return request(path, body, true);
    }
    // 204 (push) and empty bodies parse to null; only pull returns JSON.
    let json: unknown = null;
    let text = "";
    if (res.ok) {
      if (res.status !== 204) {
        try {
          json = await res.json();
        } catch {
          json = null;
        }
      }
    } else {
      try {
        text = await res.text();
      } catch {
        text = "";
      }
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  // Custom puller/pusher: the backend already returns/accepts the exact DD31 v1
  // shapes, so we forward Replicache's request body verbatim (only the fields
  // the endpoints read) and wrap the result in the puller/pusher envelopes.
  const puller: Puller = async (requestBody): Promise<PullerResultV1> => {
    const req = requestBody as PullRequestV1;
    const { status, ok, json, text } = await request("/kv/pull", {
      clientGroupID: req.clientGroupID,
      cookie: req.cookie ?? null,
    });
    const httpRequestInfo = {
      httpStatusCode: status,
      errorMessage: ok ? "" : text,
    };
    if (!ok) return { httpRequestInfo };
    // Backend pull response is `{ cookie, lastMutationIDChanges, patch }` —
    // already a PullResponseOKV1.
    return { response: json as PullerResultV1["response"], httpRequestInfo };
  };

  const pusher: Pusher = async (requestBody): Promise<PusherResult> => {
    const req = requestBody as PushRequestV1;
    const { status, ok, text } = await request("/kv/push", {
      clientGroupID: req.clientGroupID,
      mutations: req.mutations,
    });
    return {
      httpRequestInfo: { httpStatusCode: status, errorMessage: ok ? "" : text },
    };
  };

  // Optimistic mutators. `set` stamps the same `{ value, author, updatedAt }`
  // the server will project, so the optimistic view never flickers when the
  // authoritative pull lands. Names match the backend mutators ("set" / "del").
  const mutators = {
    async set(tx: WriteTransaction, args: { key: string; value: unknown }) {
      const v: KvStoredValue = {
        value: args.value,
        author: host.getMemberId(),
        updatedAt: new Date().toISOString(),
      };
      await tx.set(
        args.key,
        v as unknown as Parameters<WriteTransaction["set"]>[1],
      );
    },
    async del(tx: WriteTransaction, args: { key: string }) {
      await tx.del(args.key);
    },
  };

  // Persist to IndexedDB so a reload rehydrates instantly and offline reads
  // work. A sandbox without `allow-same-origin` gives the iframe an opaque
  // origin ("null"), where `indexedDB` is present but every call throws — fall
  // back to the in-memory store there.
  const hasIdb =
    typeof indexedDB !== "undefined" &&
    typeof location !== "undefined" &&
    location.origin !== "null";
  const kvStore = hasIdb ? "idb" : "mem";

  const rep = new Replicache({
    name: host.dbName,
    licenseKey: LICENSE_KEY,
    kvStore,
    puller,
    pusher,
    mutators,
    // Most hosts are poke-driven. Development proxies that buffer SSE can
    // provide a short polling fallback without adding production backend load.
    pullInterval: host.pullIntervalMs ?? null,
  });

  // Scan `prefix`, projecting stored values to public entries and hiding the
  // reserved prefixes unless the caller explicitly targets them. Replicache
  // scans in ascending key order, so the result is already sorted by key.
  async function matching(
    tx: ReadTransaction,
    prefix: string,
  ): Promise<KvEntry[]> {
    const hideMp = !prefix.startsWith(MP_PREFIX);
    const hideChat = !prefix.startsWith(CHAT_PREFIX);
    const out: KvEntry[] = [];
    for await (const [key, raw] of tx.scan({ prefix }).entries()) {
      if (hideMp && key.startsWith(MP_PREFIX)) continue;
      if (hideChat && key.startsWith(CHAT_PREFIX)) continue;
      const v = raw as unknown as KvStoredValue;
      out.push({
        key,
        value: v.value,
        author: v.author ?? null,
        updatedAt: v.updatedAt,
      });
    }
    return out;
  }

  return {
    async start() {
      // Replicache opens its persistent local store during construction. Do
      // not hide that snapshot behind the network: subscribers must be able
      // to render IndexedDB immediately while a fresh pull runs in the
      // background. A brand-new store still fills as soon as the pull completes.
      void rep.pull({ now: true }).catch(() => {});
    },
    async get(key) {
      const v = await rep.query((tx) => tx.get(key));
      return v != null ? (v as unknown as KvStoredValue).value : null;
    },
    async set(key, value) {
      await rep.mutate.set({ key, value });
    },
    async delete(key) {
      await rep.mutate.del({ key });
    },
    list(prefix) {
      return rep.query((tx) => matching(tx, prefix));
    },
    subscribe(prefix, cb) {
      return rep.subscribe((tx) => matching(tx, prefix), { onData: cb });
    },
    poke() {
      rep.pull().catch(() => {});
    },
    close() {
      return rep.close();
    },
  };
}
