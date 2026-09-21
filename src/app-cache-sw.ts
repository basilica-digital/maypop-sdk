// @ts-nocheck -- Compiled for a service-worker global rather than a Window.
/**
 * Per-app-instance cache worker for `window.maypop`.
 *
 * Registered by the SDK (`v1.js`) from inside the sandboxed app iframe, at
 * the app's OWN origin (`{appId}.<apps suffix>` or `b-{bundleId}...`)
 * — never cross-origin, since service worker registration requires the
 * script to be same-origin with the registering document. Nothing serves
 * this path as a real file: `/_maypop-sw.js` is a reserved name the apps-host
 * dispatch answers directly (see `app_hosts.rs`), before bundle resolution.
 *
 * What it does: intercepts fetches to `/_upload/{cid}` — a path that ALSO
 * isn't a real route; the SW answers it entirely itself. `cid` is
 * content-addressed (its bytes never change), so a plain GET is cache-first,
 * exactly like the main frontend's `uploads-sw.js` does for its own
 * `/_uploads/{cid}`. A GET carrying a `Range` header (audio/video seeking)
 * is never cached — it's fetched fresh every time so native seek/scrub keeps
 * working — but it's still intercepted here, since nothing else would answer
 * it either.
 *
 * Fetching the underlying bytes needs a signed GCS URL, which needs a valid
 * app-session token — something only the PAGE has (the SDK's handshake with
 * the host). The page pushes `{ apiBase, token }` over to this worker
 * whenever it changes (`maypop:config`); if a fetch arrives before that ever
 * happened (the worker can be evicted and restarted independently of the
 * page), the worker pulls it on demand from whichever client is asking
 * (`maypop:request-config`).
 */
// Bump the suffix on any change that should invalidate previously-cached
// bytes (not every change needs to — this is about cache correctness, not
// script versioning). `CACHE_NAME_PREFIX` groups every version this worker
// has ever used, so `activate` can find and drop the superseded ones below.
const CACHE_NAME_PREFIX = "maypop-app-cache-";
const CACHE_NAME = CACHE_NAME_PREFIX + "v1";
const UPLOAD_PATH = /^\/_upload\/([^/]+)$/;

// { apiBase, token } | null — populated by the page, lost on worker restart.
let config = null;
// Per-restart cache of in-flight config pulls, keyed by client id, so two
// concurrent fetches from the same client share one round trip.
const configRequests = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from a superseded version of this worker — otherwise a
      // CACHE_NAME bump (e.g. because cached bytes turned out to be wrong)
      // leaves the old, stale cache sitting in storage forever alongside the
      // new one. Mirrors `uploads-sw.js`'s same cleanup.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_NAME_PREFIX) && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "maypop:config" && data.apiBase && data.token) {
    config = { apiBase: data.apiBase, token: data.token };
  }
});

/** Ask whichever client is making this request for fresh config. */
function pullConfig(clientId) {
  if (!clientId) return Promise.resolve(null);
  let pending = configRequests.get(clientId);
  if (pending) return pending;
  pending = self.clients.get(clientId).then(
    (client) =>
      new Promise((resolve) => {
        if (!client) return resolve(null);
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 5000);
        channel.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve(e.data?.apiBase && e.data?.token ? e.data : null);
        };
        client.postMessage({ type: "maypop:request-config" }, [channel.port2]);
      }),
  );
  configRequests.set(clientId, pending);
  pending.finally(() => configRequests.delete(clientId));
  return pending;
}

async function ensureConfig(clientId) {
  if (config) return config;
  const pulled = await pullConfig(clientId);
  if (pulled) config = pulled;
  return config;
}

/** Mint a signed download URL for `cid` via the app-api, using `cfg`'s token. */
async function signedUrlFor(cfg, cid) {
  const res = await fetch(cfg.apiBase + "/app-api/drive/" + encodeURIComponent(cid), {
    headers: { Authorization: "Bearer " + cfg.token },
  });
  if (!res.ok) throw new Error("drive/" + cid + " -> " + res.status);
  const body = await res.json();
  return body.url;
}

async function handleUpload(event, cid) {
  const isRange = event.request.headers.has("range");
  if (!isRange) {
    const cached = await caches.match(event.request);
    if (cached) return cached;
  }

  const cfg = await ensureConfig(event.clientId);
  if (!cfg) return new Response("no app session available", { status: 401 });

  let signedUrl;
  try {
    signedUrl = await signedUrlFor(cfg, cid);
  } catch {
    return new Response("failed to resolve " + cid, { status: 502 });
  }

  const upstreamHeaders = {};
  const range = event.request.headers.get("range");
  if (range) upstreamHeaders.Range = range;
  const upstream = await fetch(signedUrl, { headers: upstreamHeaders });

  // Never cache partial content — caching a byte range under the plain
  // request key would corrupt the next full-file read.
  if (isRange || upstream.status === 206 || !upstream.ok) return upstream;

  const cache = await caches.open(CACHE_NAME);
  cache.put(event.request, upstream.clone()).catch(() => {}); // best-effort
  return upstream;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const match = new URL(event.request.url).pathname.match(UPLOAD_PATH);
  if (!match) return;
  event.respondWith(handleUpload(event, match[1]));
});
