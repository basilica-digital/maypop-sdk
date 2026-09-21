// @ts-nocheck -- This classic script receives dynamic host data; v1.ts is the
// checked public boundary and capability modules own their local types.
/**
 * window.maypop — SDK v1 for embedded Maypop apps.
 *
 * Loaded inside the sandboxed, cross-origin app iframe. The host page
 * completes a MessagePort handshake and hands over a short-lived, scoped
 * app token; everything else talks to /app-api directly. The app never
 * sees the user's real session, real user UUIDs, or anything beyond its
 * granted scopes.
 *
 * Host handshake protocol (host page side):
 *
 *   const channel = new MessageChannel();
 *   iframe.contentWindow.postMessage(
 *     {
 *       type: "maypop:init",
 *       context: { appId, apiBase },
 *       token: { token, expiresIn, scopes },
 *     },
 *     appOrigin,
 *     [channel.port2],
 *   );
 *   channel.port1.onmessage = async (e) => {
 *     if (e.data.type === "maypop:refresh") {
 *       const t = await refreshAppToken(); // POST /app-sessions/refresh
 *       channel.port1.postMessage({ type: "maypop:token", ...t });
 *     }
 *   };
 *   // Optional pushes: { type: "maypop:token", ... } (proactive rotate),
 *   //                  { type: "maypop:revoked" }.
 *
 * Guest sessions (a visitor who opened a public app by its URL) can carry one
 * extra field on init:
 *
 *   { type: "maypop:init", context, token, signInRequired: true }
 *
 * The token of a signed-out visitor holds no write scopes — the server caps an
 * account-less guest at reader whatever the app's link access says — so such a
 * session is read-only like any other, and `mode` reports it. What the flag
 * adds is the REASON: this one is read-only only because nobody is signed in,
 * and signing in through the same URL would make it read-write. That is worth
 * offering, where an app whose link only grants `view` has nothing to offer.
 *
 * So the flag is a signal, not a permission: apps read `maypop.signInRequired`
 * and show "Sign in to save" where they would otherwise show a dead read-only
 * state. Either that affordance or an actual write attempt asks the host for
 * its login card:
 *
 *   { type: "maypop:sign-in" }          // SDK -> host, over the port, no payload
 *
 * A write attempt also rejects with `maypop/sign-in-required` rather than
 * `maypop/read-only`, so an app that never checks the flag still surfaces
 * something actionable. The message carries no copy on purpose: the app is
 * untrusted content and must not get to write the words on a login card.
 * Signing in re-mints an identified session and re-runs this handshake, so the
 * app comes back able to write.
 *
 * Re-inits: the host may post `maypop:init` again at any time (it re-sends
 * with a fresh channel until it sees an ack, and re-runs the whole handshake
 * when its side remounts — closing the port it had adopted). The SDK adopts
 * EVERY init it receives, newest port wins, and acks each one; the host must
 * likewise treat the newest ack as the live channel. A MessagePort has no
 * close event, so "first init wins" would leave the SDK holding a silently
 * dead channel — refreshes unanswered, every call 401 once the first access
 * token expired.
 *
 * Hello: the SDK also announces itself to the parent as a plain window
 * message the moment its init listener is registered (and again on a bfcache
 * restore / on returning to visible while un-inited):
 *
 *   { type: "maypop:hello" }        // SDK → parent, no payload
 *
 * A host that understands it should treat a hello as "(re)send init now" —
 * this closes every timing race the blind retry loop has (slow bundles,
 * suspended timers, a host that already gave up, a reloaded document holding
 * no port while the host still holds the old one). Hosts that predate hello
 * simply ignore it; the retry loop remains the fallback.
 *
 * Opening sibling apps: maypop.apps.open() is a HOST action (the host page
 * navigates its own UI), so it rides the port. The SDK posts:
 *
 *   { type: "maypop:open-app", id, app }   // app: id of the target app, from
 *                                          // maypop.apps.list()
 *
 * and the host validates the target against whatever it can actually switch
 * to, switches to it, and replies keyed by the same `id`:
 *
 *   { type: "maypop:open-app-done",  id }
 *   { type: "maypop:open-app-error", id, error, code? }  // e.g.
 *                                          // "maypop/app-not-found",
 *                                          // "maypop/unsupported"
 *
 * Opening group settings is the same pattern (host owns the manage modal):
 *
 *   { type: "maypop:open-group-settings", id, tab? }
 *   // tab: "details" | "members" | "settings" | "analytics" | "advanced"
 *
 *   { type: "maypop:open-group-settings-done",  id }
 *   { type: "maypop:open-group-settings-error", id, error, code? }
 *                                          // "maypop/invalid-tab",
 *                                          // "maypop/unsupported"
 *
 * Hosts that predate these messages (or surfaces where switching apps /
 * opening settings makes no sense — share-link guest pages, the phone-handoff
 * shell) never reply, so the SDK also rejects on a timeout rather than
 * leaving the call pending.
 *
 * Theme: the host posts its UI theme as a plain window message (not over the
 * port, so apps without the SDK can listen for it too) — once shortly after
 * load and again on every change:
 *
 *   { type: "maypop:theme", theme: "light" | "dark" }
 *
 * The SDK mirrors it onto the document (`<html data-theme>` + `color-scheme`,
 * which app styles can target), exposes `maypop.theme`, and emits
 * "themechange".
 */
(() => {
  "use strict";

  // Package imports can be evaluated during SSR. Install the SDK only in the
  // browser; the package entry reports a targeted error if server code tries
  // to use a browser capability.
  if (typeof window === "undefined") return;

  if (window.maypop) return; // idempotent

  // ----------------------------------------------------------------- state
  let port = null;
  let context = null; // { appId, apiBase }
  // The deep-link fragment the host put in the iframe URL (notify({ path })).
  // Captured once at load, before any in-app router rewrites location.hash.
  const launchPath = location.hash ? location.hash.slice(1) : null;
  let token = null; // { token, expiresIn, scopes }
  let me = null; // /app-api/me response
  // Read-only *because* nobody is signed in — signing in would grant writes.
  let signInRequired = false;
  let theme = null; // host UI theme; null until the host first reports it
  let booted = false; // fetched /me for this session
  let refreshTimer = null;
  const listeners = {
    modechange: new Set(),
    revoked: new Set(),
    themechange: new Set(),
  };

  // A real gesture arms one sign-in prompt, consumed when it fires, so a write
  // retry loop (or an on-mount seed write) can't re-nag before the next gesture.
  let promptArmed = false;
  try {
    const armPrompt = () => {
      promptArmed = true;
    };
    for (const type of ["pointerdown", "keydown"]) {
      window.addEventListener(type, armPrompt, { capture: true, passive: true });
    }
  } catch {
    // No window (non-browser host).
  }

  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const err = (code, message) => {
    const e = new Error(message || code);
    e.code = code;
    return e;
  };

  const emit = (event) => listeners[event]?.forEach((cb) => cb());

  const scopes = () => {
    return token ? token.scopes.split(" ") : [];
  };
  const can = (scope) => scopes().includes(scope);
  // `kv:write-trial` (an anonymous guest on a `use` app) reads as writable so
  // the app stays interactive; the write itself is still refused and prompts.
  const mode = () =>
    can("kv:write") || can("kv:write-trial") ? "read-write" : "read-only";

  // ------------------------------------------------------------- sign-in gate
  // Ask the host to open its own sign-in card. No payload: the copy on that
  // card is the host's, and an app — untrusted content — must never get to
  // put words on it.
  const requestSignIn = () => {
    port?.postMessage({ type: "maypop:sign-in" });
  };

  // The sign-in half of every capability refusal, shared by the guards below.
  //
  // An account-less guest's token carries only the reader scopes — the server
  // caps it there whatever the app's link access grants — so writes, AI,
  // integrations and multiplayer all end up refused. The question this answers
  // is whether signing in would change that: the host sets `signInRequired`
  // exactly when it would, and only then is a login card worth raising. An app
  // whose link grants `view` withholds the same things from everybody, so it
  // falls through to its caller's plain refusal and nobody is interrupted by a
  // prompt that would not help them.
  //
  // Returns (does nothing) when a sign-in is not the answer; the caller then
  // throws whatever its own refusal is.
  function refuseUntilSignedIn(action) {
    if (!signInRequired) return;
    // Always refused (thrown below); only the prompt is rationed to one per gesture.
    if (promptArmed) {
      promptArmed = false;
      requestSignIn();
    }
    throw err("maypop/sign-in-required", "sign in to " + action);
  }

  // Refuse a write with the reason that tells the app what to do about it.
  function requireWrite(scope, action) {
    if (can(scope)) return;
    refuseUntilSignedIn(action);
    throw err("maypop/read-only", "this session is read-only");
  }

  // ---------------------------------------------------------------- theme
  // Mirror the host's UI theme onto the document so app styles (`data-theme`)
  // and native form controls (`color-scheme`) follow it with no app code.
  // An app that deliberately pins one theme opts out of the document mutation
  // with <html data-maypop-theme="manual">; `maypop.theme` and "themechange"
  // still track the host so it can react its own way if it wants.
  function applyTheme(t) {
    if ((t !== "light" && t !== "dark") || t === theme) return;
    theme = t;
    if (document.documentElement.dataset.maypopTheme !== "manual") {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }
    emit("themechange");
  }

  // Theme arrives as a plain window message — not over the handshake port —
  // so it works before init completes and for apps that skip the SDK.
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.type === "maypop:theme") applyTheme(d.theme);
  });

  // -------------------------------------------------------------- handshake
  // Every init is adopted, newest port wins (see the re-init note in the
  // header). Window messages arrive in order, so both sides converge on the
  // last channel: we end on the last init the host posted, the host ends on
  // the last ack we sent (same channel).
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.type !== "maypop:init" || !e.ports[0]) return;
    const reinit = port !== null;
    const prevMode = reinit ? mode() : null;
    if (reinit) port.close();
    port = e.ports[0];
    // Normalize the host's context onto one id. A host older than this SDK
    // still sends the two legacy names — the SDK is served from the API and
    // can be newer than the page embedding it.
    context = d.context
      ? {
          ...d.context,
          appId:
            d.context.appId ?? d.context.publicationId ?? d.context.templateId,
        }
      : d.context;

    // Whether a sign-in is what stands between this viewer and writing. Set
    // for a signed-out guest of an app whose link access is `use`; off for a
    // member session, for an app that is read-only for everyone, and for any
    // host that predates the flag.
    signInRequired = d.signInRequired === true;

    setToken(d.token);
    ensureCacheWorker();

    port.onmessage = (m) => {
      const msg = m.data;
      if (!msg) return;
      if (msg.type === "maypop:token") {
        const prev = mode();
        setToken(msg);
        if (mode() !== prev) emit("modechange");
        flushTokenWaiters();
      } else if (msg.type === "maypop:revoked") {
        token = null;
        emit("revoked");
      } else {
        // Host replies to port-delegated requests (maypop.apps.open acks).
        routeHostMessage(msg);
      }
    };
    port.start?.();
    port.postMessage({ type: "maypop:ready" });

    if (reinit) {
      if (mode() !== prevMode) emit("modechange");
      // The init carried a fresh token — anything blocked on a refresh can go.
      flushTokenWaiters();
    }
    if (!booted) {
      booted = true;
      bootstrap().then(readyResolve, readyReject);
    }
  });

  // Announce ourselves to the host the moment the init listener above is
  // registered. The host's blind retry loop alone is a race: on a slow mobile
  // load the SDK can come up after the host's retry window has lapsed, leaving
  // the app stuck on its own loading state with no recovery. A hello tells the
  // host "an SDK is listening NOW — (re)send init". Carries no data, so "*" is
  // fine; the host validates the source window before reacting.
  const sayHello = () => {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({ type: "maypop:hello" }, "*");
    } catch {
      // Sandboxed parents can throw on postMessage; the host's own retry
      // loop still covers us.
    }
  };
  sayHello();
  // A bfcache restore can resurrect the page holding a dead port (the host
  // side re-ran its handshake or the channel didn't survive suspension);
  // re-announce so the host re-inits with a fresh channel — newest port wins
  // on both sides, so a redundant hello is harmless.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) sayHello();
  });
  // Mobile webviews throttle/suspend background timers hard enough that the
  // host's retry loop can lapse while this page loads hidden; re-announce on
  // return to visible if init never arrived.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !port) sayHello();
  });

  function setToken(t) {
    token = { token: t.token, expiresIn: t.expiresIn, scopes: t.scopes };
    clearTimeout(refreshTimer);
    // Ask the host for a fresh token a minute before this one dies.
    const lead = Math.max((t.expiresIn - 60) * 1000, 5000);
    refreshTimer = setTimeout(requestRefresh, lead);
    pushCacheWorkerConfig();
  }

  let tokenWaiters = [];
  function requestRefresh() {
    port?.postMessage({ type: "maypop:refresh" });
  }
  function flushTokenWaiters() {
    tokenWaiters.forEach((r) => r());
    tokenWaiters = [];
  }
  function freshToken() {
    // Wait (briefly) for the host to answer a refresh request.
    return new Promise((resolve, reject) => {
      requestRefresh();
      const t = setTimeout(
        () => reject(err("maypop/no-token", "token refresh timed out")),
        10000,
      );
      tokenWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async function bootstrap() {
    me = await api("GET", "/me");
  }

  // ------------------------------------------------------------------ http
  // `mapCodes` opts the new name-addressed drive surface into actionable
  // 404/409 errors without changing the behavior of existing SDK endpoints.
  async function api(method, path, body, retried, mapCodes) {
    if (!token) throw err("maypop/revoked", "session revoked");
    const res = await fetch(context.apiBase + "/app-api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      await freshToken();
      return api(method, path, body, true, mapCodes);
    }
    if (res.status === 401) throw err("maypop/revoked", "session revoked");
    if (res.status === 403)
      throw err("maypop/forbidden", "missing scope for " + path);
    if (!res.ok) throw await apiError(res, method + " " + path, mapCodes);
    if (res.status === 200 && method !== "DELETE") return res.json();
    return null;
  }

  // Build a useful error from a non-OK response. The backend proxies provider
  // errors verbatim ({ error: { code, message } }) and wraps its own as
  // { error: "...", code? } — surface whichever message exists, and give the
  // two actionable failures their own codes so apps can react instead of
  // showing a generic error:
  //   - 402 / "quota_exceeded" -> "maypop/ai-limit": the user is out of daily
  //     AI credits (or their plan doesn't cover the call) — show an "out of
  //     daily AI credits — try tomorrow or upgrade" state, never auto-retry.
  //   - content moderation -> "maypop/ai-blocked": offer a "rephrase / try
  //     again" path.
  async function apiError(res, what, mapCodes) {
    let detail = null;
    let code = null;
    try {
      const body = await res.json();
      const e = body?.error;
      detail = typeof e === "string" ? e : (e?.message ?? null);
      code = typeof e?.code === "string" ? e.code : null;
      if (!code && typeof body?.code === "string") code = body.code;
    } catch {
      // non-JSON body — fall through to the generic message
    }
    if (mapCodes && res.status === 404) {
      return err("maypop/not-found", detail || what + " -> 404");
    }
    if (mapCodes && res.status === 409) {
      return err("maypop/conflict", detail || what + " -> 409");
    }
    if (code === "storage_quota_exceeded") {
      return err(
        "maypop/storage-full",
        "Group storage is full — free up space or upgrade your plan.",
      );
    }
    if (code === "sandbox_capability_unavailable") {
      return err(
        "maypop/unsupported",
        detail ||
          "This capability is not available in the local Maypop sandbox.",
      );
    }
    if (res.status === 402 || code === "quota_exceeded") {
      return err(
        "maypop/ai-limit",
        "Daily AI limit reached — try again tomorrow or upgrade your plan.",
      );
    }
    const blocked =
      /sensitive/i.test(code ?? "") || /sensitive/i.test(detail ?? "");
    return err(
      blocked ? "maypop/ai-blocked" : "maypop/error",
      detail || what + " -> " + res.status,
    );
  }

  // ----------------------------------------------------------------- kv ---
  // The app's shared, group-scoped store. Two implementations behind ONE public
  // surface (get/set/delete/list/subscribe):
  //   - networked session: a real Replicache client with a custom puller/pusher
  //     over /app-api/kv/{pull,push}, loaded lazily from /sdk/kv-v1.js (so the
  //     ~100KB runtime only downloads for apps that sync). The poke SSE stream
  //     drives `rep.pull()`.

  // Reserved key prefix for maypop.agent stored chat history (see the
  // `conversations` API below). Per-viewer (`~chat/{viewerId}/{id}`) and hidden
  // from generic kv reads so transcripts don't leak into subscribe("") apps.
  const CHAT_PREFIX = "~chat/";

  const kv = (() => {
    // ---- networked engine (lazily-loaded Replicache chunk) ----
    let engine = null;
    let engineReady = null; // promise; created on first use, resolves to the engine
    let es = null; // poke EventSource

    // Stable per (viewer × app instance): a reload rehydrates the same local
    // IndexedDB, and distinct viewers never share one. `me` is set by the time
    // the engine loads (start/methods await readyPromise first).
    function kvDbName() {
      const app = context?.appId || "app";
      return "maypop-kv-" + app + "-" + (me?.id ?? "anon");
    }

    function connectPoke() {
      if (!token || context?.kvPullIntervalMs != null) return;
      es?.close();
      es = new EventSource(
        context.apiBase +
          "/app-api/kv/poke?token=" +
          encodeURIComponent(token.token),
      );
      // A poke is only a hint, not a durable queue. Pull after every successful
      // (re)connect so writes committed while the stream was down—or between
      // the initial pull and the first connection—cannot leave this client
      // stale until some unrelated future write.
      es.onopen = () => engine?.poke();
      es.onmessage = () => engine?.poke();
      // The token in the stream URL expires; reconnect with the current one.
      es.onerror = () => {
        es?.close();
        es = null;
        // Reauthorization can intentionally close a stream when its policy
        // view changes. Pull before reconnecting so contractions clear rows
        // even when the replacement stream is no longer permitted.
        engine?.poke();
        setTimeout(connectPoke, 2000);
      };
    }

    // Load + initialize the Replicache engine once. Resolves to the engine, or
    // null when there's no store to read (no kv:read scope).
    function loadEngine() {
      engineReady ||= (async () => {
        if (!can("kv:read")) return null;
        const mod = await import(context.apiBase + "/sdk/kv-v1.js");
        engine = mod.createKvEngine({
          apiBase: context.apiBase,
          dbName: kvDbName(),
          getToken: () => (token ? token.token : null),
          refreshToken: () => freshToken(),
          getMemberId: () => me?.id ?? null,
          pullIntervalMs: context.kvPullIntervalMs,
        });
        await engine.start();
        connectPoke();
        return engine;
      })();
      return engineReady;
    }

    return {
      async start() {
        if (!can("kv:read")) return; // app without a store / scope
        await loadEngine();
      },
      async get(key) {
        await readyPromise;
        const eng = await loadEngine();
        return eng ? eng.get(key) : null;
      },
      async set(key, value) {
        await readyPromise;
        requireWrite("kv:write", "save changes");
        const eng = await loadEngine();
        if (eng) await eng.set(key, value);
      },
      async delete(key) {
        await readyPromise;
        requireWrite("kv:write", "delete data");
        const eng = await loadEngine();
        if (eng) await eng.delete(key);
      },
      async list(opts) {
        await readyPromise;
        const prefix = opts?.prefix ?? "";
        const eng = await loadEngine();
        return eng ? eng.list(prefix) : [];
      },
      subscribe(prefix, cb) {
        let off = null;
        let cancelled = false;
        readyPromise
          .then(async () => {
            if (cancelled) return;
            const eng = await loadEngine();
            if (cancelled) return;
            if (!eng) {
              cb([]); // no store/scope — match the empty one-shot reads
              return;
            }
            off = eng.subscribe(prefix, cb);
          })
          .catch(() => {});
        return () => {
          cancelled = true;
          if (off) off();
        };
      },
    };
  })();

  // ------------------------------------------------------- app cache worker
  // Registers `/_maypop-sw.js` (served on this app's own origin — see
  // `app_hosts.rs` on the backend) so `drive.imageUrl()` can hand it
  // `/_upload/{cid}` requests instead of doing its own IndexedDB dance. The
  // worker does cache-first for a plain GET but still intercepts (without
  // caching) a `Range` GET, so unlike the IndexedDB path alone, this one is
  // also safe for video/audio seeking. Registration MUST happen from here,
  // not from wherever this script's bytes were fetched from — service worker
  // registration requires the script to be same-origin with the registering
  // document, and this script executes in the app's own iframe origin
  // regardless of where its bytes came from.
  //
  // Falls back to the IndexedDB path when unsupported: registering a service
  // worker from inside a SANDBOXED iframe (even with `allow-same-origin`) has
  // an inconsistent history across engines — confirmed working in both
  // Chromium and Safari; Firefox unverified. `imageUrl()` never depends on
  // this having succeeded, but every failure path logs why, so the exact
  // cause is diagnosable from a browser's own console instead of just "it
  // didn't work".
  let cacheWorkerReady = null;
  function ensureCacheWorker() {
    if (!("serviceWorker" in navigator)) {
      // Distinguishes "API unavailable in this context" from "available but
      // registration rejected" (the catch below) — the two look identical
      // from the outside (imageUrl() falls back either way) but point at
      // different root causes.
      console.warn(
        "maypop: serviceWorker not available in this context (sandboxed iframe?) -- drive.imageUrl() will use the IndexedDB fallback",
      );
      return Promise.resolve(null);
    }
    cacheWorkerReady ||= navigator.serviceWorker
      .register("/_maypop-sw.js")
      .then(async (reg) => {
        if (!navigator.serviceWorker.controller) {
          // Bounded: an engine that registers but never fires
          // controllerchange (rather than cleanly rejecting) would otherwise
          // hang this promise forever — and, transitively, every
          // `imageUrl()` call, since it awaits this.
          const tookControl = await Promise.race([
            new Promise((resolve) => {
              navigator.serviceWorker.addEventListener(
                "controllerchange",
                () => resolve(true),
                { once: true },
              );
            }),
            new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
          ]);
          if (!tookControl) {
            console.warn(
              "maypop: cache worker registered but never took control (no controllerchange within 5s) -- drive.imageUrl() will use the IndexedDB fallback",
            );
            return null;
          }
        }
        pushCacheWorkerConfig();
        return reg;
      })
      .catch((e) => {
        console.warn(
          "maypop: cache worker registration failed (" +
            (e && e.name) +
            ": " +
            (e && e.message) +
            ") -- drive.imageUrl() will use the IndexedDB fallback",
        );
        return null;
      });
    return cacheWorkerReady;
  }

  // Push the current token to the worker whenever it's set or rotated. The
  // worker can also be evicted and restarted independently of this page —
  // see the `maypop:request-config` reply below for that case.
  function pushCacheWorkerConfig() {
    if (!token || !navigator.serviceWorker?.controller) return;
    navigator.serviceWorker.controller.postMessage({
      type: "maypop:config",
      apiBase: context.apiBase,
      token: token.token,
    });
  }

  if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "maypop:request-config" || !e.ports[0]) return;
      e.ports[0].postMessage(
        token ? { apiBase: context.apiBase, token: token.token } : null,
      );
    });
  }

  // -------------------------------------------------------------- drive ---
  // The app's private storage. Bytes go straight to GCS
  // (presign -> POST -> confirm); reads come back as short-lived signed URLs.
  // Files are scoped to this app instance — never another app's storage.
  // Keep this in sync with uploads::MAX_UPLOAD_BYTES on the backend. Checking
  // before the upload starts keeps an oversized Blob from exhausting the
  // iframe while the browser clones it.
  const MAX_DRIVE_UPLOAD_BYTES = 50 * 1024 * 1024;
  //
  // `url()` mints a fresh signed URL on every call (unique query string, so
  // the browser's HTTP cache never dedupes it) — fine for video/audio, where
  // native Range-request streaming matters more than caching. `imageUrl()` is
  // a separate, additive method for pictures: it caches the decoded bytes in
  // IndexedDB, keyed by cid (content-addressed — a cid's bytes never change),
  // so a repeat load of the same image is instant and works offline. It's
  // IndexedDB rather than the Cache API/a service worker because this script's
  // bytes are fetched cross-origin from the maypop API, so it can't register a
  // same-origin SW for the app's own iframe origin — but IndexedDB opened by
  // an already-executing script lives in the origin it runs in regardless of
  // where the script came from.
  const IMAGE_CACHE_STORE = "images";
  let imageCacheDbPromise = null;
  // cid -> object URL, so repeat calls within one session reuse the same
  // blob: URL instead of minting (and leaking) a new one each time.
  const imageObjectUrls = new Map();

  function imageCacheDbName() {
    const app = context?.appId || "app";
    return "maypop-drive-cache-" + app;
  }

  function openImageCacheDb() {
    imageCacheDbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(imageCacheDbName(), 1);
      req.onupgradeneeded = () =>
        req.result.createObjectStore(IMAGE_CACHE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return imageCacheDbPromise;
  }

  async function cachedImageBlob(cid) {
    try {
      const db = await openImageCacheDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_CACHE_STORE, "readonly");
        const req = tx.objectStore(IMAGE_CACHE_STORE).get(cid);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null; // best-effort — private browsing / quota / unsupported
    }
  }

  // TODO: no eviction — relies on the browser's own storage-pressure eviction
  // for this origin. Add an LRU/size cap if apps end up caching many/large
  // images.
  function storeImageBlob(cid, blob) {
    openImageCacheDb()
      .then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(IMAGE_CACHE_STORE, "readwrite");
            tx.objectStore(IMAGE_CACHE_STORE).put(blob, cid);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          }),
      )
      .catch(() => {}); // best-effort — a cache-write failure shouldn't surface
  }

  // duplicate-name resolution.
  function driveMimeFromName(name) {
    const base = name.split("/").pop() ?? name;
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    const map = {
      md: "text/markdown",
      markdown: "text/markdown",
      txt: "text/plain",
      json: "application/json",
      csv: "text/csv",
      html: "text/html",
      htm: "text/html",
      css: "text/css",
      js: "text/javascript",
      mjs: "text/javascript",
      xml: "application/xml",
      svg: "image/svg+xml",
      yaml: "application/yaml",
      yml: "application/yaml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      pdf: "application/pdf",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      mp4: "video/mp4",
      webm: "video/webm",
    };
    return map[ext] ?? "";
  }

  function driveContentToBlob(content, name) {
    if (typeof content === "string") {
      return new Blob([content], {
        type: driveMimeFromName(name) || "text/plain",
      });
    }
    if (content instanceof Blob) return content;
    if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
      return new Blob([content], { type: driveMimeFromName(name) });
    }
    throw err(
      "maypop/invalid-file",
      "write requires a string, Blob, ArrayBuffer, or typed array",
    );
  }

  const MAX_DRIVE_NAME_BYTES = 512;

  function validateDriveName(name) {
    const ok =
      typeof name === "string" &&
      name.length > 0 &&
      new TextEncoder().encode(name).length <= MAX_DRIVE_NAME_BYTES &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f-\u009f]/.test(name) &&
      !name.includes("\\") &&
      name.split("/").every((seg) => seg && seg !== "." && seg !== "..");
    if (!ok)
      throw err("maypop/invalid-file", "invalid file name: " + String(name));
  }

  async function driveFileHandle(name) {
    if (!can("drive:read"))
      throw err("maypop/forbidden", "missing scope for drive:read");
    return api(
      "GET",
      "/drive/file?name=" + encodeURIComponent(name),
      undefined,
      undefined,
      true,
    );
  }

  const drive = {
    /** Maximum accepted size for one upload or write, in bytes. */
    maxUploadBytes: MAX_DRIVE_UPLOAD_BYTES,
    /** List files, optionally filtered by a path-like prefix. */
    async list(opts) {
      await readyPromise;
      const prefix = opts?.prefix ?? "";
      if (!can("drive:read")) return [];
      const q = prefix ? "?prefix=" + encodeURIComponent(prefix) : "";
      return api("GET", "/drive" + q);
    },
    /** File metadata by name, or null when it does not exist. */
    async stat(name) {
      await readyPromise;
      try {
        const res = await driveFileHandle(name);
        return res.file;
      } catch (e) {
        if (e?.code === "maypop/not-found") return null;
        throw e;
      }
    },
    /** Read a file's content as text by name. */
    async read(name) {
      await readyPromise;
      const res = await driveFileHandle(name);
      const bytes = await fetch(res.url);
      if (!bytes.ok)
        throw err("maypop/error", "GET file bytes -> " + bytes.status);
      return bytes.text();
    },
    /** Read a file's content as a Blob by name. */
    async readBlob(name) {
      await readyPromise;
      const res = await driveFileHandle(name);
      const bytes = await fetch(res.url);
      if (!bytes.ok)
        throw err("maypop/error", "GET file bytes -> " + bytes.status);
      return bytes.blob();
    },
    /**
     * Create a new file by name. This never overwrites: an existing name
     * rejects with `maypop/conflict`.
     */
    async write(name, content) {
      await readyPromise;
      requireWrite("drive:write", "save files");
      validateDriveName(name);
      const blob = driveContentToBlob(content, name);
      if (blob.size > MAX_DRIVE_UPLOAD_BYTES) {
        throw err(
          "maypop/file-too-large",
          "file is too large; the maximum write size is 50 MiB",
        );
      }

      const { url, fields, cid } = await api("POST", "/drive/presign");
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("Content-Type", blob.type || "application/octet-stream");
      form.append("file", blob);
      const up = await fetch(url, { method: "POST", body: form });
      if (!up.ok)
        throw err("maypop/upload-failed", "GCS upload -> " + up.status);
      return api(
        "POST",
        "/drive/confirm",
        { cid, name, createOnly: true },
        undefined,
        true,
      );
    },
    /**
     * Upload a File/Blob to the app's storage. Resolves to the created file
     * ({ id, cid, name, mimeType, size, uploadedBy, createdAt }).
     */
    async upload(file, opts) {
      await readyPromise;
      requireWrite("drive:write", "upload files");
      if (
        !file ||
        typeof file.size !== "number" ||
        !Number.isFinite(file.size)
      ) {
        throw err("maypop/invalid-file", "upload requires a File or Blob");
      }
      if (file.size > MAX_DRIVE_UPLOAD_BYTES) {
        throw err(
          "maypop/file-too-large",
          "file is too large; the maximum upload size is 50 MiB",
        );
      }
      const name = opts?.name ?? file?.name ?? "file";

      const { url, fields, cid } = await api("POST", "/drive/presign");
      // Multipart POST straight to GCS: policy fields first, our Content-Type
      // next, and the file field LAST (GCS requires the file to come last).
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("Content-Type", file.type || "application/octet-stream");
      form.append("file", file);
      const up = await fetch(url, { method: "POST", body: form });
      if (!up.ok)
        throw err("maypop/upload-failed", "GCS upload -> " + up.status);

      return api("POST", "/drive/confirm", { cid, name });
    },
    /** A short-lived signed download URL for a file by cid. */
    async url(cid) {
      await readyPromise;
      if (!can("drive:read"))
        throw err("maypop/forbidden", "missing scope for drive:read");
      const res = await api("GET", "/drive/" + encodeURIComponent(cid));
      return res.url;
    },
    /**
     * Like `url()`, but for images: caches the bytes locally (IndexedDB) so a
     * repeat load of the same cid is instant and works offline, instead of
     * re-signing + re-fetching from GCS every call. Returns an object URL
     * (`blob:...`) valid for this page's lifetime — safe to drop into an
     * `<img>` `src`, not something to persist or share.
     */
    async imageUrl(cid) {
      await readyPromise;
      if (!can("drive:read"))
        throw err("maypop/forbidden", "missing scope for drive:read");

      // Prefer the cache worker when it's up: same-origin, cache-first, and
      // (unlike the IndexedDB path below) safe for Range requests too. Falls
      // through to IndexedDB if registration failed or hasn't resolved yet.
      if (await ensureCacheWorker()) {
        return "/_upload/" + encodeURIComponent(cid);
      }

      const existingObjectUrl = imageObjectUrls.get(cid);
      if (existingObjectUrl) return existingObjectUrl;

      const cachedBlob = await cachedImageBlob(cid);
      if (cachedBlob) {
        const objectUrl = URL.createObjectURL(cachedBlob);
        imageObjectUrls.set(cid, objectUrl);
        return objectUrl;
      }

      const res = await api("GET", "/drive/" + encodeURIComponent(cid));
      const signedRes = await fetch(res.url);
      if (!signedRes.ok)
        throw err("maypop/error", "GET " + res.url + " -> " + signedRes.status);
      const blob = await signedRes.blob();
      storeImageBlob(cid, blob);
      const objectUrl = URL.createObjectURL(blob);
      imageObjectUrls.set(cid, objectUrl);
      return objectUrl;
    },
    /** Delete a file from the app's storage by cid. */
    async delete(cid) {
      await readyPromise;
      requireWrite("drive:write", "delete files");
      await api("DELETE", "/drive/" + encodeURIComponent(cid));
    },
    /** Delete every live file with this exact name. */
    async remove(name) {
      await readyPromise;
      requireWrite("drive:write", "delete files");
      await api(
        "DELETE",
        "/drive/file?name=" + encodeURIComponent(name),
        undefined,
        undefined,
        true,
      );
    },
  };

  // The app's roster, shared by maypop.members(), the deprecated
  // maypop.group.members(), and the multiplayer name lookup. Everyone who can
  // reach this app through any group it is attached to, plus its author — not
  // the whole roster.
  async function fetchMembers() {
    await readyPromise;
    return api("GET", "/members");
  }

  // DEPRECATED, and inert: maypop.group.info() no longer describes a real
  // group. A group is launch context, not something an app is "in", so leaking
  // its name and image into every app was giving apps an identity that isn't
  // theirs. Kept callable (published bundles still call it) but answered
  // locally with a neutral placeholder — no round-trip, nothing group-derived.
  // Removed from v1.d.ts so new apps never learn it.
  async function fetchGroupInfo() {
    await readyPromise;
    return { name: "Group", description: null, avatarUrl: null };
  }

  // maypop.group.openSettings(tab?) — HOST action: open the manage-group
  // modal on an optional tab. Same port/timeout pattern as apps.open().
  const OPEN_GROUP_SETTINGS_TIMEOUT_MS = 10_000;
  const GROUP_SETTINGS_TABS = {
    details: true,
    members: true,
    settings: true,
    analytics: true,
    advanced: true,
  };

  async function openGroupSettings(tab) {
    await readyPromise;
    let section = "details";
    if (tab != null && tab !== "") {
      if (typeof tab !== "string" || !GROUP_SETTINGS_TABS[tab]) {
        throw err(
          "maypop/invalid-tab",
          'openSettings tab must be "details", "members", "settings", "analytics", or "advanced"',
        );
      }
      section = tab;
    }
    return new Promise((resolve, reject) => {
      if (!port) return reject(err("maypop/error", "no host channel"));
      const reqId = "settings-" + aiSeq++;
      const timer = setTimeout(() => {
        aiPending.delete(reqId);
        reject(
          err(
            "maypop/unsupported",
            "the host did not respond — opening group settings is not supported here",
          ),
        );
      }, OPEN_GROUP_SETTINGS_TIMEOUT_MS);
      aiPending.set(reqId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        mode: "open-group-settings",
      });
      try {
        port.postMessage({
          type: "maypop:open-group-settings",
          id: reqId,
          tab: section,
        });
      } catch (e) {
        clearTimeout(timer);
        aiPending.delete(reqId);
        reject(
          err("maypop/error", "failed to reach host: " + (e?.message || e)),
        );
      }
    });
  }

  // maypop.share({ path, title? }) — HOST action: open a Maypop share card
  // with a copyable deep link to `path`. Same port/timeout pattern as
  // openGroupSettings(). The host resolves the link audience and does the copy.
  const SHARE_TIMEOUT_MS = 10_000;

  async function share(opts) {
    await readyPromise;
    if (!opts || typeof opts.path !== "string" || !opts.path.startsWith("/")) {
      throw err("maypop/invalid-path", "share: path must be a site-relative string like \"/item/42\"");
    }
    const title =
      typeof opts.title === "string" && opts.title.trim() ? opts.title.trim() : undefined;
    return new Promise((resolve, reject) => {
      if (!port) return reject(err("maypop/error", "no host channel"));
      const reqId = "share-" + aiSeq++;
      const timer = setTimeout(() => {
        aiPending.delete(reqId);
        reject(err("maypop/unsupported", "the host did not respond — sharing is not supported here"));
      }, SHARE_TIMEOUT_MS);
      aiPending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        mode: "share",
      });
      try {
        port.postMessage({ type: "maypop:share", id: reqId, path: opts.path, title });
      } catch (e) {
        clearTimeout(timer);
        aiPending.delete(reqId);
        reject(err("maypop/error", "failed to reach host: " + (e?.message || e)));
      }
    });
  }

  // ----------------------------------------------------------- multiplayer
  // Ephemeral shared "rooms" — live session state that exists ONLY in the
  // participants' browsers. A room is an iroh-docs replica (in memory)
  // synced peer-to-peer over an iroh-gossip swarm: writes reach live peers
  // at p2p latency (tens of ms), late joiners pull the current state from
  // whoever is already there, and when the last participant closes their
  // tab the room's state ceases to exist ANYWHERE. The backend's only jobs
  // are rendezvous (who is dialable right now) and handing out the room's
  // namespace key — it never sees session state. Anything worth keeping
  // after the party must be written to maypop.kv.
  //
  // Presence is the rendezvous roster (server-side 45s announce TTL), so it
  // never depends on peers' clocks; state values ride the doc. Read-only
  // viewers (mp:list without mp:join) spectate: they sync the doc read-only,
  // aren't listed in peers, and their writes throw maypop/read-only.
  const multiplayer = (() => {
    const PRESENCE_TIMEOUT = 45_000; // matches the rendezvous announce TTL
    // Coalesce rapid setState/setMyState writes. Deliberately coarse: every
    // doc write is a distinct blob whose CONTENT peers fetch individually
    // (~1/s sustained under load, measured), so a fast stream of writes
    // queues up far beyond the presented state and takes ages to converge.
    // An isolated write still sends immediately (trailing-edge throttle);
    // this only caps bursts. Continuous streams (cursors, drags) belong on
    // multiplayer.connect(), not room state.
    const WRITE_THROTTLE = 250;

    // Trailing-edge throttle: the LATEST value always lands, at most one
    // write per `ms` — rapid calls (drags, sliders) cost one doc write.
    function throttled(ms, write) {
      let timer = null;
      let last = 0;
      let queued;
      const fn = (value) => {
        queued = value;
        if (timer) return;
        const wait = Math.max(0, last + ms - Date.now());
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          write(queued);
        }, wait);
      };
      fn.cancel = () => clearTimeout(timer);
      return fn;
    }

    async function join(roomId = "main", opts = {}) {
      await readyPromise;
      if (typeof roomId !== "string" || !/^[\w.-]{1,60}$/.test(roomId))
        throw err(
          "maypop/bad-room",
          "room ids must match [A-Za-z0-9_.-]{1,60}",
        );
      const presenceTimeout = Math.min(
        opts.presenceTimeoutMs ?? PRESENCE_TIMEOUT,
        PRESENCE_TIMEOUT,
      );

      const subs = new Set();
      const names = new Map(); // peer id -> roster row (username, avatarUrl)
      let namesCooldown = 0;
      let left = false;
      let myValue = null; // my published per-peer state (always shown for self)
      let sharedLocal; // local echo of setState until the doc write lands
      let sharedLocalSet = false;

      if (!can("mp:list"))
        throw err("maypop/forbidden", "missing scope for mp:list");
      const writable = () => can("mp:join");

      // Rooms and connect() sessions share the rendezvous but must not mix
      // peers, so doc rooms announce under a distinct name.
      const rvRoom = "doc-" + roomId;
      const STATE_KEY = "state";
      const myKey = "peer/" + me.id;

      // Fetch the namespace key BEFORE announcing: the server rotates the
      // key of a room that has been empty past its TTL, so the first joiner
      // of a fresh party starts a fresh namespace.
      const key = await api(
        "GET",
        "/multiplayer/room-key?room=" + encodeURIComponent(rvRoom),
      );
      const iroh = await loadIroh();
      const node = await iroh.RoomNode.spawn();
      const myEndpointId = node.endpointId();
      let myAddr;

      let roster = new Map(); // endpointId -> rendezvous row (memberId, addr, updatedAt)
      const known = new Set(); // endpointIds already handed to the doc engine
      let doc = new Map(); // doc key -> { raw, value } (latest per key)
      let sharedStamp = 0; // when setState last ran (bounds the local echo)

      function notify() {
        for (const cb of subs) cb(room);
      }

      // Display names are best-effort sugar: resolve peer ids through the
      // group roster when group:read is granted. Anonymous guests have no
      // roster row and stay nameless.
      async function refreshNames() {
        if (Date.now() < namesCooldown) return;
        namesCooldown = Date.now() + 10_000;
        try {
          const { members } = await fetchMembers();
          for (const m of members) names.set(m.id, m);
          notify();
        } catch {
          // no group:read — peers render with username: null
        }
      }

      async function announce() {
        if (!writable()) return;
        // Re-resolve the address on every heartbeat — the relay path can
        // change mid-session and late joiners dial what we last published.
        try {
          myAddr = await node.dialableAddr();
        } catch {
          // keep publishing the last known address
        }
        await api("POST", "/multiplayer/announce", {
          room: rvRoom,
          endpointId: myEndpointId,
          addr: myAddr,
        });
      }

      async function discover() {
        const { peers: found } = await api(
          "GET",
          "/multiplayer/peers?room=" + encodeURIComponent(rvRoom),
        );
        const next = new Map();
        const freshAddrs = [];
        for (const p of found) {
          if (p.endpointId === myEndpointId) continue;
          if (Date.now() - Date.parse(p.updatedAt) > presenceTimeout) continue;
          next.set(p.endpointId, p);
          if (!known.has(p.endpointId)) {
            known.add(p.endpointId);
            try {
              freshAddrs.push(JSON.parse(p.addr));
            } catch {
              // unparsable announce — skip
            }
          }
        }
        const changed =
          next.size !== roster.size ||
          [...next.keys()].some((k) => !roster.has(k));
        roster = next;
        if (freshAddrs.length)
          node.addPeers(JSON.stringify(freshAddrs)).catch(() => {});
        if (changed) notify();
      }

      // Everything between spawn and a working session can throw (offline,
      // revoked token, relay trouble); shut the node down on the way out or
      // its endpoint/router tasks would live for the rest of the page.
      let eventReader;
      try {
        myAddr = await node.dialableAddr();
        await announce();
        await discover().catch(() => {});
        const bootstrap = JSON.stringify(
          [...roster.values()].flatMap((p) => {
            try {
              return [JSON.parse(p.addr)];
            } catch {
              return [];
            }
          }),
        );
        if (writable() && key.namespaceSecret) {
          await node.joinWrite(key.namespaceSecret, bootstrap);
        } else {
          await node.joinRead(key.namespaceId, bootstrap);
        }
        eventReader = (await node.events()).getReader();
      } catch (e) {
        node.close().catch(() => {});
        throw e;
      }

      // Re-read the doc on any engine event, coalesced — rooms are a
      // handful of keys, so a full re-read is cheaper than tracking deltas.
      let refreshQueued = false;
      function refreshEntries() {
        if (refreshQueued || left) return;
        refreshQueued = true;
        setTimeout(async () => {
          refreshQueued = false;
          if (left) return;
          try {
            const list = JSON.parse(await node.entries());
            doc = new Map(
              list.map((e) => {
                let value = null;
                try {
                  value = JSON.parse(e.value);
                } catch {
                  // not from this SDK — surface as null
                }
                return [e.key, { raw: e.value, value }];
              }),
            );
            // Our optimistic setState echo lifts once the doc holds the
            // CURRENT local value (comparing against the latest sharedLocal
            // avoids reverting to an older write while a rapid follow-up is
            // still queued in the throttle), or after a grace period when
            // the write never echoed (failed, or superseded remotely).
            if (sharedLocalSet) {
              const entry = doc.get(STATE_KEY);
              const echoed =
                entry && entry.raw === JSON.stringify(sharedLocal ?? null);
              if (echoed || Date.now() - sharedStamp > 3_000)
                sharedLocalSet = false;
            }
            notify();
          } catch {
            // node closed mid-read — the session is over
          }
        }, 30);
      }

      (async () => {
        try {
          for (;;) {
            const { value, done } = await eventReader.read();
            if (done) break;
            // A new gossip neighbor often means a peer we haven't seen in
            // the rendezvous yet — refresh the roster promptly.
            if (value.type === "neighborUp") discover().catch(() => {});
            refreshEntries();
          }
        } catch {
          // node closed underneath the reader — session is over
        }
      })();
      refreshEntries();

      const announceTimer = setInterval(() => {
        if (!left) announce().catch(() => {});
      }, P2P_ANNOUNCE_INTERVAL);
      const discoverTimer = setInterval(() => {
        if (!left) discover().catch(() => {});
      }, P2P_DISCOVER_INTERVAL);

      const writeShared = throttled(WRITE_THROTTLE, (v) => {
        node.set(STATE_KEY, JSON.stringify(v ?? null)).catch(() => {});
      });
      const writeMine = throttled(WRITE_THROTTLE, (v) => {
        node.set(myKey, JSON.stringify(v ?? null)).catch(() => {});
      });

      function requireLiveWriter() {
        if (left) throw err("maypop/left", "this room handle has left");
        requireWrite("mp:join", "play with others");
      }

      function computePeers() {
        const byId = new Map();
        if (writable()) {
          byId.set(me.id, {
            id: me.id,
            username: me.username,
            avatarUrl: me.avatarUrl,
            state: myValue,
            updatedAt: new Date().toISOString(),
            self: true,
          });
        }
        let unknown = false;
        for (const p of roster.values()) {
          // Two tabs of the same person are one peer, matching the doc's
          // one peer/{id} key per person.
          if (byId.has(p.memberId)) continue;
          const n = names.get(p.memberId);
          if (!n) unknown = true;
          byId.set(p.memberId, {
            id: p.memberId,
            username: n?.username ?? null,
            avatarUrl: n?.avatarUrl ?? null,
            state: doc.get("peer/" + p.memberId)?.value ?? null,
            updatedAt: p.updatedAt,
            self: false,
          });
        }
        const peers = [...byId.values()];
        peers.sort((a, b) => (a.id < b.id ? -1 : 1));
        if (unknown) refreshNames();
        return peers;
      }

      async function leave() {
        if (left) return;
        left = true;
        clearInterval(announceTimer);
        clearInterval(discoverTimer);
        writeShared.cancel();
        writeMine.cancel();
        removeEventListener("pagehide", onHide);
        subs.clear();
        if (writable()) {
          await api(
            "DELETE",
            "/multiplayer/announce?room=" + encodeURIComponent(rvRoom),
          ).catch(() => {});
        }
        await node.close().catch(() => {});
        // Release the event pump so nothing keeps the wasm node alive.
        eventReader.cancel().catch(() => {});
      }
      // Best-effort goodbye on tab close; the announce TTL is the guarantee
      // when this doesn't get to run.
      const onHide = () => {
        leave().catch(() => {});
      };
      addEventListener("pagehide", onHide);

      const room = {
        id: roomId,
        get me() {
          return me.id;
        },
        get peers() {
          return computePeers();
        },
        get state() {
          if (sharedLocalSet) return sharedLocal;
          return doc.get(STATE_KEY)?.value ?? null;
        },
        setState(value) {
          requireLiveWriter();
          sharedLocal = value;
          sharedLocalSet = true;
          sharedStamp = Date.now();
          notify();
          writeShared(value);
        },
        setMyState(value) {
          requireLiveWriter();
          myValue = value;
          notify();
          writeMine(value);
        },
        subscribe(cb) {
          subs.add(cb);
          cb(room);
          return () => subs.delete(cb);
        },
        leave,
      };
      return room;
    }

    // ------------------------------------------------------------ p2p (iroh)
    // Real-time peer-to-peer transport for what kv rooms can't do: high-rate
    // packets (action games, live cursors, streams). Peers connect DIRECTLY
    // to each other over iroh (QUIC — relayed via WebSocket in browsers, but
    // end-to-end encrypted); the backend never sees a packet. Its only role
    // is rendezvous: peers announce "I'm available" with their dialable
    // address and poll who else is online (/app-api/multiplayer/*). The
    // ~2.5MB wasm transport loads lazily on the first connect().
    const P2P_ANNOUNCE_INTERVAL = 20_000; // server-side listing TTL is 45s
    const P2P_DISCOVER_INTERVAL = 10_000;

    let irohLoad = null;
    function loadIroh() {
      irohLoad ??= (async () => {
        const mod = await import(context.apiBase + "/sdk/iroh-v1.js");
        await mod.default({
          module_or_path: context.apiBase + "/sdk/iroh-v1_bg.wasm",
        });
        return mod;
      })();
      return irohLoad;
    }

    async function connect(roomId = "main", opts = {}) {
      await readyPromise;
      // "mesh" (default): one direct connection per peer pair — lowest
      // latency, authentic sender identity, true 1:1 sends; right for a
      // handful of players. "swarm": an iroh-gossip topic — each tab keeps
      // ~5 connections however big the room is and broadcasts are relayed
      // by the swarm; right for whole-group sessions.
      //
      // UNDOCUMENTED for now: swarm mode works end-to-end but the iroh wasm
      // api layer (irpc) currently quantizes both sends and deliveries to
      // ~1/s (wakers don't fire; progress rides a housekeeping tick — the
      // same upstream issue that paces docs content fetches). Do not
      // advertise it in v1.d.ts or the studio guide until that is fixed.
      const topology = opts.topology === "swarm" ? "swarm" : "mesh";
      // Length-capped to match the rendezvous server's validation, so a bad
      // id fails loudly here instead of silently 400ing on every announce.
      const maxLen = topology === "swarm" ? 61 : 64; // "sw-" prefix fits 64
      if (
        typeof roomId !== "string" ||
        !new RegExp("^[\\w.-]{1," + maxLen + "}$").test(roomId)
      )
        throw err(
          "maypop/bad-room",
          "room ids must match [A-Za-z0-9_.-]{1," + maxLen + "}",
        );

      const subs = new Set(); // peers-change subscribers
      const msgSubs = new Set(); // message subscribers
      let left = false;

      if (!can("mp:list"))
        throw err("maypop/forbidden", "missing scope for mp:list");
      // Guests (mp:list only) can dial announced peers but aren't listed
      // themselves.
      const announces = can("mp:join");

      // Swarm and mesh sessions in the "same" room are separate worlds —
      // distinct rendezvous namespaces keep their peer lists from mixing.
      const rvRoom = topology === "swarm" ? "sw-" + roomId : roomId;
      const iroh = await loadIroh();
      const node =
        topology === "swarm"
          ? await iroh.SwarmNode.spawn()
          : await iroh.MpNode.spawn();
      const myId = node.endpointId();
      let myAddr;
      let swarmJoined = false;
      const known = new Set(); // endpointIds already fed to the swarm

      const roster = new Map(); // endpointId -> { memberId, addr } from rendezvous
      const connected = new Set(); // mesh: live connections; swarm: gossip neighbors
      const names = new Map(); // memberId -> roster row (username, avatarUrl)
      let namesCooldown = 0;

      function notify() {
        for (const cb of subs) cb(session);
      }

      // Same best-effort display-name sugar as kv rooms: resolve member ids
      // through the group roster when group:read is granted.
      async function refreshNames() {
        if (Date.now() < namesCooldown) return;
        namesCooldown = Date.now() + 10_000;
        try {
          const { members } = await fetchMembers();
          for (const m of members) names.set(m.id, m);
          notify();
        } catch {
          // no group:read — peers render with username: null
        }
      }

      function computePeers() {
        const peers = [
          {
            id: me.id,
            endpointId: myId,
            username: me.username,
            avatarUrl: me.avatarUrl,
            self: true,
            connected: true,
          },
        ];
        let unknown = false;
        for (const [endpointId, r] of roster) {
          const n = names.get(r.memberId);
          if (!n) unknown = true;
          peers.push({
            id: r.memberId,
            endpointId,
            username: n?.username ?? null,
            avatarUrl: n?.avatarUrl ?? null,
            self: false,
            // Mesh: a live direct connection to that peer. Swarm: reachable
            // through the topic (any neighbor at all means the swarm relays
            // for us — gossip has no per-peer link to report).
            connected:
              topology === "swarm"
                ? connected.size > 0
                : connected.has(endpointId),
          });
        }
        // Mesh only: live connections whose announce expired (peer stopped
        // heartbeating but the pipe is still up) stay visible.
        if (topology === "mesh") {
          for (const endpointId of connected) {
            if (!roster.has(endpointId)) {
              peers.push({
                id: null,
                endpointId,
                username: null,
                avatarUrl: null,
                self: false,
                connected: true,
              });
            }
          }
        }
        peers.sort((a, b) => (a.endpointId < b.endpointId ? -1 : 1));
        if (unknown) refreshNames();
        return peers;
      }

      // Pump the node's single event stream into JS callbacks. The reader is
      // cancelled by leave() — without that, the pending read() would keep
      // the node and the whole session closure alive forever.
      function pumpEvent(value) {
        if (value.type === "peerConnected" || value.type === "neighborUp") {
          connected.add(value.peer);
          notify();
        } else if (
          value.type === "peerDisconnected" ||
          value.type === "neighborDown"
        ) {
          connected.delete(value.peer);
          notify();
        } else if (value.type === "message") {
          let payload;
          try {
            payload = JSON.parse(value.payload);
          } catch {
            return; // not from this SDK — ignore
          }
          if (topology === "swarm") {
            // Swarm messages are relayed, so the wire carries an envelope:
            // f = origin endpoint id (sender-claimed — gossip can't attest
            // the author the way a direct connection does), to = optional
            // addressee for send().
            if (!payload || typeof payload !== "object") return;
            if (payload.to && payload.to !== myId) return;
            for (const cb of msgSubs)
              cb({ from: String(payload.f ?? ""), payload: payload.p });
          } else {
            for (const cb of msgSubs) cb({ from: value.from, payload });
          }
        }
        // swarm "lagged" (receiver overran its buffer) needs no handling —
        // messages are best-effort by contract.
      }

      async function announce() {
        if (!announces) return;
        // Re-resolve the address on every heartbeat — the relay path can
        // change mid-session and late joiners dial what we last published.
        try {
          myAddr = await node.dialableAddr();
        } catch {
          // keep publishing the last known address
        }
        await api("POST", "/multiplayer/announce", {
          room: rvRoom,
          endpointId: myId,
          addr: myAddr,
        });
      }

      async function discover() {
        const { peers: found } = await api(
          "GET",
          "/multiplayer/peers?room=" + encodeURIComponent(rvRoom),
        );
        const next = new Map();
        for (const p of found) {
          if (p.endpointId === myId) continue;
          next.set(p.endpointId, { memberId: p.memberId, addr: p.addr });
        }
        const changed =
          next.size !== roster.size ||
          [...next.keys()].some((k) => !roster.has(k));
        roster.clear();
        for (const [k, v] of next) roster.set(k, v);
        if (topology === "swarm") {
          // Feed newly-seen peers into the swarm's membership; gossip picks
          // its own ~5 active neighbors from there.
          const fresh = [];
          for (const [endpointId, r] of roster) {
            if (known.has(endpointId)) continue;
            known.add(endpointId);
            try {
              fresh.push(JSON.parse(r.addr));
            } catch {
              // unparsable announce — skip
            }
          }
          if (swarmJoined && fresh.length) {
            node.joinPeers(JSON.stringify(fresh)).catch(() => {});
          }
        } else {
          // Deterministic dialer: the lexicographically smaller endpoint id
          // initiates, so exactly one side dials. Retried every tick until
          // the connection lands (the node dedupes if both dial at once).
          // Non-announcing peers (guests) are invisible to everyone else, so
          // they must always be the dialer regardless of id order.
          for (const [endpointId, r] of roster) {
            if (
              !connected.has(endpointId) &&
              (!announces || myId < endpointId)
            ) {
              node.connect(r.addr).catch(() => {});
            }
          }
        }
        if (changed) notify();
      }

      // Everything between spawn and a working session can throw; shut the
      // node down on the way out or its endpoint would live on for the rest
      // of the page.
      let eventReader;
      try {
        myAddr = await node.dialableAddr();
        await announce();
        await discover().catch(() => {});
        if (topology === "swarm") {
          // The topic id is derivable by anyone in this app instance — the
          // swarm's admission control is the rendezvous (scopes), the same
          // as the mesh's.
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              "maypop-mp/" + (context.appId ?? "") + "/" + roomId,
            ),
          );
          const topicHex = [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          const bootstrap = [];
          for (const [endpointId, r] of roster) {
            known.add(endpointId);
            try {
              bootstrap.push(JSON.parse(r.addr));
            } catch {
              // unparsable announce — skip
            }
          }
          await node.join(topicHex, JSON.stringify(bootstrap));
          swarmJoined = true;
        }
        eventReader = node.events().getReader();
      } catch (e) {
        node.close().catch(() => {});
        throw e;
      }
      (async () => {
        try {
          for (;;) {
            const { value, done } = await eventReader.read();
            if (done) break;
            pumpEvent(value);
          }
        } catch {
          // node closed underneath the reader — session is over
        }
      })();
      const announceTimer = setInterval(() => {
        if (!left) announce().catch(() => {});
      }, P2P_ANNOUNCE_INTERVAL);
      const discoverTimer = setInterval(() => {
        if (!left) discover().catch(() => {});
      }, P2P_DISCOVER_INTERVAL);

      function requireLive() {
        if (left) throw err("maypop/left", "this session handle has left");
      }

      async function leave() {
        if (left) return;
        left = true;
        clearInterval(announceTimer);
        clearInterval(discoverTimer);
        removeEventListener("pagehide", onHide);
        subs.clear();
        msgSubs.clear();
        if (announces) {
          await api(
            "DELETE",
            "/multiplayer/announce?room=" + encodeURIComponent(rvRoom),
          ).catch(() => {});
        }
        await node.close().catch(() => {});
        // Release the event pump so nothing keeps the wasm node alive.
        eventReader.cancel().catch(() => {});
      }
      // Best-effort goodbye on tab close; the announce TTL is the guarantee
      // when this doesn't get to run.
      const onHide = () => {
        leave().catch(() => {});
      };
      addEventListener("pagehide", onHide);

      const session = {
        id: roomId,
        get me() {
          return myId;
        },
        get peers() {
          return computePeers();
        },
        async send(endpointId, payload) {
          requireLive();
          // Spectators (mp:list without mp:join) may receive live packets but
          // not emit them — else a guest's stream reaches writer peers who
          // persist it, "saving" their edits through the back door.
          requireWrite("mp:join", "play with others");
          if (topology === "swarm") {
            // Gossip has no 1:1 channel: an addressed broadcast rides the
            // topic and everyone else drops it. Fine for turn-taking; not
            // private beyond the room (nothing in a session is).
            if (connected.size === 0)
              throw err("maypop/not-connected", "no connection to that peer");
            await node.broadcast(
              JSON.stringify({ f: myId, to: endpointId, p: payload ?? null }),
            );
            return;
          }
          if (!connected.has(endpointId))
            throw err("maypop/not-connected", "no connection to that peer");
          await node.send(endpointId, JSON.stringify(payload ?? null));
        },
        async broadcast(payload) {
          requireLive();
          // Same spectator gate as send().
          requireWrite("mp:join", "play with others");
          if (topology === "swarm") {
            await node.broadcast(
              JSON.stringify({ f: myId, p: payload ?? null }),
            );
            // Gossip gives no delivery count; report reachable-through-swarm.
            return connected.size > 0 ? roster.size : 0;
          }
          return await node.broadcast(JSON.stringify(payload ?? null));
        },
        onMessage(cb) {
          msgSubs.add(cb);
          return () => msgSubs.delete(cb);
        },
        subscribe(cb) {
          subs.add(cb);
          cb(session);
          return () => subs.delete(cb);
        },
        leave,
      };
      return session;
    }

    return { join, connect };
  })();

  // ----------------------------------------------------------------- ai ---
  // Pending host-delegated port requests (maypop.apps.open,
  // maypop.group.openSettings), keyed by request id.
  let aiSeq = 0;
  const aiPending = new Map(); // id -> { resolve, reject, mode }

  // The app's gateway to the AI providers. Calls go through /app-api/ai using
  // server-side provider keys (never exposed to the app) and are gated by the
  // ai:use scope. Chat requests/responses are OpenAI-compatible shapes, except
  // `model` is a named tier ("fast" | "smart") the server resolves to a
  // provider model — the app never names a raw model. Image generation takes
  // no model at all (the server pins one).
  const ai = {
    /** List the model tiers this app may call ({ data: [{ id, description }] }). */
    async models() {
      await readyPromise;
      requireAi();
      return api("GET", "/ai/models");
    },
    /**
     * Run a chat completion and resolve with the full OpenAI-shaped response.
     * `request` is { model: "fast" | "smart", messages, ...openai fields }.
     * A message's `content` may be an array mixing text and image_url parts
     * for vision input (see MaypopAiMessage in v1.d.ts) — forwarded verbatim;
     * the backend inlines/resizes the images.
     */
    async chat(request) {
      await readyPromise;
      requireAi("use AI");
      return api("POST", "/ai/chat/completions", { ...request, stream: false });
    },
    /**
     * Stream a chat completion. Calls onDelta(text, event) for each token as it
     * arrives and resolves with the full concatenated text once the stream
     * ends — ideal for narration that should appear as it's generated.
     */
    async stream(request, onDelta) {
      await readyPromise;
      requireAi("use AI");
      return aiStream({ ...request, stream: true }, onDelta);
    },
    /**
     * Generate images and resolve with the provider-shaped response
     * ({ data: [{ url | b64_json }], ... }). `request` is { prompt, ...provider
     * fields } — optionally `image` (URL / base64 data URL, or an array) for
     * image-to-image editing. `tier` is "fast" (default) or "quality";
     * the server selects the provider model and promotes small sizes to 2K.
     */
    async image(request) {
      await readyPromise;
      requireAi("use AI");
      return api("POST", "/ai/images/generations", request);
    },
    /** Generate an MP4 with the fast (default) or quality video model. */
    async video(request) {
      await readyPromise;
      requireAi("use AI");
      return api("POST", "/ai/videos/generations", request);
    },
    /** Generate music, voices, sound effects, or ambience (up to 120 seconds). */
    async audio(request) {
      await readyPromise;
      requireAi("use AI");
      return api("POST", "/ai/audio/generations", request);
    },
    /**
     * Transcribe speech to text and resolve with { text, ... }. `request` is
     * { audio: Blob | base64-string, format?, language?, ... } — no model; the
     * server pins one. A Blob is base64-encoded for you (format inferred from
     * its MIME type).
     */
    async transcribe(request) {
      await readyPromise;
      requireAi("use AI");
      const body = await buildTranscriptionBody(request);
      return api("POST", "/ai/audio/transcriptions", body);
    },
  };

  // Normalize a transcribe() request into the backend's STT JSON body:
  // { input_audio: { data: <base64 raw bytes>, format }, ...rest }. Accepts a
  // Blob (encoded here) or a pre-encoded base64 string.
  async function buildTranscriptionBody(request) {
    if (!request || request.audio == null)
      throw err("maypop/error", "transcribe: `audio` is required");
    const { audio, format, ...rest } = request;
    let data;
    let fmt = format;
    if (typeof audio === "string") {
      if (!fmt)
        throw err(
          "maypop/error",
          "transcribe: `format` is required when `audio` is a base64 string",
        );
      data = audio;
    } else if (typeof Blob !== "undefined" && audio instanceof Blob) {
      data = await blobToBase64(audio);
      fmt = fmt || mimeToAudioFormat(audio.type);
    } else {
      throw err(
        "maypop/error",
        "transcribe: `audio` must be a Blob or a base64 string",
      );
    }
    return { ...rest, input_audio: { data, format: fmt } };
  }

  // Base64-encode a Blob's raw bytes (no data: URI prefix). Chunked so a large
  // recording doesn't blow the argument limit of String.fromCharCode.
  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // "audio/webm;codecs=opus" -> "webm"; "audio/mpeg" -> "mp3". Best-effort; an
  // unrecognized subtype is passed through for the provider to accept or reject.
  function mimeToAudioFormat(mime) {
    if (!mime) return undefined;
    const sub = mime.split(";")[0].split("/")[1];
    if (!sub) return undefined;
    return sub === "mpeg" ? "mp3" : sub.replace(/^x-/, "");
  }

  // Guard shared by the ai.* methods: it refuses the viewers the server
  // withheld ai:use from (an account-less guest, most of all).
  //
  // A guest with no account is exactly the case where the refusal is worth
  // acting on rather than reporting: AI comes with the same reader cap the
  // writes do, and signing in through the same URL lifts both. So pass the
  // `action` when the app is trying to DO something — a chat box that answers
  // "please sign in" and opens the card is the whole point, where "missing
  // scope for ai:use" is a dead end. Leave it off for a call that only asks
  // what this viewer *could* run (`models()`): a login card nobody pressed for
  // is an interruption, and the honest answer to a capability question is the
  // capability.
  function requireAi(action) {
    if (can("ai:use")) return;
    if (action) refuseUntilSignedIn(action);
    throw err("maypop/forbidden", "missing scope for ai:use");
  }

  // Route a host->SDK reply to its pending open-app / open-group-settings
  // request. Unknown ids and message types are ignored.
  function routeHostMessage(msg) {
    if (!msg || typeof msg.type !== "string") return;
    const p = msg.id != null ? aiPending.get(msg.id) : null;
    if (!p) return;
    if (msg.type === "maypop:open-app-done") {
      aiPending.delete(msg.id);
      p.resolve();
      return;
    }
    if (msg.type === "maypop:open-app-error") {
      aiPending.delete(msg.id);
      p.reject(
        err(msg.code || "maypop/error", msg.error || "failed to open the app"),
      );
      return;
    }
    if (msg.type === "maypop:share-done") {
      const p = aiPending.get(msg.id);
      if (p) { aiPending.delete(msg.id); p.resolve(); }
      return;
    }
    if (msg.type === "maypop:share-error") {
      const p = aiPending.get(msg.id);
      if (p) { aiPending.delete(msg.id); p.reject(err(msg.code || "maypop/error", msg.error || "share failed")); }
      return;
    }
    if (msg.type === "maypop:open-group-settings-done") {
      aiPending.delete(msg.id);
      p.resolve();
      return;
    }
    if (msg.type === "maypop:open-group-settings-error") {
      aiPending.delete(msg.id);
      p.reject(
        err(
          msg.code || "maypop/error",
          msg.error || "failed to open group settings",
        ),
      );
      return;
    }
  }

  // Read the SSE chat-completion stream directly (the buffered `api()` helper
  // can't expose tokens as they arrive). Mirrors `api()`'s one-shot refresh
  // retry on a 401 so a token rotating mid-session doesn't surface as an error.
  async function aiStream(body, onDelta, retried) {
    if (!token) throw err("maypop/revoked", "session revoked");
    const res = await fetch(context.apiBase + "/app-api/ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      await freshToken();
      return aiStream(body, onDelta, true);
    }
    if (res.status === 401) throw err("maypop/revoked", "session revoked");
    if (res.status === 403)
      throw err("maypop/forbidden", "missing scope for ai:use");
    if (!res.ok) throw await apiError(res, "POST /ai/chat/completions");
    if (!res.body)
      throw err("maypop/error", "POST /ai/chat/completions -> no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // keep-alive comment or partial — skip
        }
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onDelta?.(delta, event);
        }
      }
    }
    return text;
  }

  // ---------------------------------------------------------------- mcp ---
  // The app's gateway to integrations (MCP servers linked onto this app).
  // Calls go through /app-api/mcp using
  // server-held credentials (never exposed to the app) and are gated by
  // mcp:use. An app with nothing connected sees servers() === [] —
  // feature-detect and degrade instead of assuming.

  // Same reasoning, and the same action/no-action split, as `requireAi`: the
  // integrations scope rides with the account, so offer the account — but only
  // when the app is actually invoking a tool, not while it feature-detects.
  function requireMcp(action) {
    if (can("mcp:use")) return;
    if (action) refuseUntilSignedIn(action);
    throw err("maypop/forbidden", "missing scope for mcp:use");
  }

  function mcpToolsList(serverId) {
    return api("POST", "/mcp/tools/list", { serverId });
  }

  // Text blocks of an MCP tool result, concatenated.
  function mcpText(result) {
    return (result && Array.isArray(result.content) ? result.content : [])
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }

  // What a wrapped tool (see mcp.tools) hands the agent: the structured
  // payload when the server provides one, else the text content. A tool-level
  // failure (isError) becomes a thrown error so the agent loop reports it.
  function mcpToolValue(result) {
    if (result && result.isError) {
      throw err("maypop/mcp-tool-error", mcpText(result) || "tool call failed");
    }
    if (result && result.structuredContent != null)
      return result.structuredContent;
    const text = mcpText(result);
    return text !== "" ? text : result;
  }

  const mcp = {
    /**
     * The integrations available to this session:
     * [{ id, name, url, account? }] (names are display names;
     * account is the public identity when known). Empty when
     * none — always feature-detect on this before building
     * integration-backed UI.
     */
    async servers() {
      await readyPromise;
      requireMcp();
      const r = await api("GET", "/mcp/servers");
      return (r && r.servers) || [];
    },
    /**
     * Invoke one MCP tool and resolve with the raw MCP result
     * ({ content, structuredContent?, isError? }). `args` must match the
     * tool's inputSchema (see tools()).
     */
    async call(serverId, name, args) {
      await readyPromise;
      requireMcp("use this app's integrations");
      return api("POST", "/mcp/tools/call", {
        serverId,
        name,
        arguments: args ?? {},
      });
    },
    /**
     * The connected servers' tools, wrapped as agent tool definitions
     * ({ name, description, parameters, execute }) — pass them straight to
     * maypop.agent.create({ tools }) for an integration-aware agent, or read
     * `parameters` (JSON Schema) to call() by hand. Scoped to one server when
     * `serverId` is given, else aggregated across all connected servers.
     */
    async tools(serverId) {
      await readyPromise;
      requireMcp();
      const servers = serverId ? [{ id: serverId }] : await mcp.servers();
      const defs = [];
      for (const s of servers) {
        const r = await mcpToolsList(s.id);
        for (const t of (r && r.tools) || []) {
          defs.push({
            name: t.name,
            description: t.description || "",
            parameters: t.inputSchema || { type: "object" },
            execute: (args) => mcp.call(s.id, t.name, args).then(mcpToolValue),
          });
        }
      }
      return defs;
    },
  };

  // --------------------------------------------------------------- link ---
  // Server-side link unfurling: hand the backend a URL and get back preview
  // metadata (title, description, a real image, site name, favicon). Apps run
  // cross-origin in a sandboxed iframe and can't fetch a third-party page (or
  // its og:image) themselves, so this is the platform's way to turn a
  // web-search result URL into a picture + link card. Gated by identity:read,
  // which every session (member or guest) holds.

  const link = {
    /**
     * Fetch link-preview metadata for a URL, resolving with
     * `{ url, title?, description?, image?, siteName?, favicon? }` — `url` is
     * the final URL after redirects; every other field is best-effort (a page
     * may expose none). `image` is an absolute URL (og:image / Twitter card),
     * which is how you get a REAL picture for a web-search result: search
     * returns article URLs, unfurl one to read its og:image. Rejects
     * "maypop/error" for an invalid/blocked URL (only public http/https hosts
     * are allowed) or a page that isn't HTML.
     */
    async unfurl(url) {
      await readyPromise;
      if (typeof url !== "string" || !url.trim())
        throw err("maypop/error", "unfurl requires a URL");
      return api("POST", "/unfurl", { url: url.trim() });
    },
  };

  // --------------------------------------------------------------- apps ---
  // DEPRECATED namespace, retained only so published bundles keep running.
  //
  // This enumerated the *group's* published apps, which made an app's view of
  // the world depend on which door its viewer came through — the same app in
  // two groups saw two different rosters, and outside a group it saw nothing.
  // list()/subscribe() are now inert (always []); open() still works, since a
  // bundle may hold an id of its own, but nothing hands ids out any more. The
  // whole namespace is gone from v1.d.ts so new apps never learn it.
  //
  // Opening is host-side navigation, so it rides the handshake port: we post
  // maypop:open-app and the host validates the target, switches its UI to it,
  // and replies done/error keyed by request id — see the header. Hosts that
  // predate the message (or surfaces that can't switch apps, like share-link
  // guest pages) never reply, so open() also fails on a timeout instead of
  // hanging forever.
  const OPEN_APP_TIMEOUT_MS = 10_000;

  const apps = {
    /**
     * DEPRECATED, and inert: always resolves to []. This listed the *group's*
     * published apps, which made an app's view of the world depend on the door
     * its viewer came through. Kept callable so published bundles keep running
     * (they already handle the empty list — that was the documented
     * behaviour); removed from v1.d.ts so new apps never learn it.
     */
    async list() {
      await readyPromise;
      return [];
    },
    /**
     * DEPRECATED, and inert: fires once with [] and never again, since list()
     * is now constant. Delivered asynchronously so callers that unsubscribe
     * synchronously still see nothing after their teardown, and with no poll
     * timer or window listeners left behind. Removed from v1.d.ts.
     */
    subscribe(cb) {
      if (typeof cb !== "function") {
        throw err("maypop/error", "subscribe requires a callback");
      }
      let stopped = false;
      void readyPromise.then(() => {
        if (stopped) return;
        try {
          cb([]);
        } catch (_) {
          /* app callback errors are the app's problem, not ours */
        }
      });
      return () => {
        stopped = true;
      };
    },
    /**
     * Ask the host to switch to another app. `id` is an app id. Resolves once
     * the host accepts; rejects with "maypop/app-not-found" for an unknown
     * target or "maypop/unsupported" when this surface can't switch apps
     * (including hosts that never reply — timeout).
     *
     * DEPRECATED along with the rest of this namespace, and removed from
     * v1.d.ts, but still wired to the host: list() no longer hands out ids,
     * so only a published bundle holding one of its own can reach it.
     */
    async open(id) {
      await readyPromise;
      if (typeof id !== "string" || !id.trim())
        throw err("maypop/error", "open requires an app id");
      const app = id.trim();
      return new Promise((resolve, reject) => {
        if (!port) return reject(err("maypop/error", "no host channel"));
        const reqId = "open-" + aiSeq++;
        const timer = setTimeout(() => {
          aiPending.delete(reqId);
          reject(
            err(
              "maypop/unsupported",
              "the host did not respond — opening apps is not supported here",
            ),
          );
        }, OPEN_APP_TIMEOUT_MS);
        aiPending.set(reqId, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
          mode: "open-app",
        });
        try {
          port.postMessage({ type: "maypop:open-app", id: reqId, app });
        } catch (e) {
          clearTimeout(timer);
          aiPending.delete(reqId);
          reject(
            err("maypop/error", "failed to reach host: " + (e?.message || e)),
          );
        }
      });
    },
  };

  // -------------------------------------------------------------- agent ---
  // Lazily-loaded conversational agent runtime: the `pi` agent loop (multi-turn
  // tool calling, streaming, context management) bundled with an
  // openai-completions provider — see /sdk/agent-v1.js. Kept out of the core
  // SDK so apps that never use an agent never download it; the chunk loads on
  // the first create() call and the browser caches it thereafter.
  let agentModulePromise = null;
  function loadAgentModule() {
    agentModulePromise ||= import(context.apiBase + "/sdk/agent-v1.js");
    return agentModulePromise;
  }

  // --- stored chat history (per viewer) ---
  // History lives in kv under CHAT_PREFIX, namespaced by viewer id so each
  // person sees only their own conversations: ~chat/{viewerId}/{id}. A stored
  // record is { id, title, updatedAt, messages, view } — `messages` is the raw
  // pi transcript (to resume a session) and `view` is the public transcript (so
  // the conversations API can list/read without loading the agent runtime).
  function chatUserPrefix() {
    return CHAT_PREFIX + encodeURIComponent(me?.id ?? "local") + "/";
  }
  function chatKey(id) {
    return chatUserPrefix() + encodeURIComponent(id);
  }
  async function loadConversation(id) {
    if (!can("kv:read")) return null;
    const r = await kv.get(chatKey(id));
    return r && Array.isArray(r.messages) ? r.messages : null;
  }
  async function saveConversation(id, record) {
    // Deliberately a silent no-op rather than a refusal: this fires on the
    // agent's own schedule, so a read-only viewer's transcript simply doesn't
    // outlive the tab. (It never reaches `requireWrite`, so a guest is never
    // shown a login card they didn't ask for.)
    if (!can("kv:write")) return;
    await kv.set(chatKey(id), {
      id,
      title: (record && record.title) || "",
      updatedAt: new Date().toISOString(),
      messages: (record && record.messages) || [],
      view: (record && record.view) || [],
    });
  }
  const conversations = {
    async list() {
      await readyPromise;
      if (!can("kv:read")) return [];
      const entries = await kv.list({ prefix: chatUserPrefix() });
      return entries
        .map((e) => e.value || {})
        .filter((r) => r.id)
        .map((r) => ({
          id: r.id,
          title: r.title || "",
          updatedAt: r.updatedAt || null,
          messageCount: Array.isArray(r.view)
            ? r.view.length
            : Array.isArray(r.messages)
              ? r.messages.length
              : 0,
        }))
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    },
    async get(id) {
      await readyPromise;
      if (!can("kv:read")) return null;
      const r = await kv.get(chatKey(id));
      if (!r) return null;
      return {
        id: r.id || id,
        title: r.title || "",
        updatedAt: r.updatedAt || null,
        messages: Array.isArray(r.view) ? r.view : [],
      };
    },
    async delete(id) {
      await readyPromise;
      if (!can("kv:write")) return;
      await kv.delete(chatKey(id));
    },
  };

  // Ready-made create/read/remove tools over the app's storage. Files are
  // immutable by name: write_file creates and reports a conflict rather than
  // silently replacing existing content.
  const DRIVE_TEXT_MIME_RE =
    /^(text\/|application\/(json|xml|yaml|javascript|ecmascript)|image\/svg)/;
  const DRIVE_READ_TOOL_MAX_CHARS = 48000;

  function driveTools(opts) {
    const mount = opts?.prefix ?? "";
    const full = (path) => mount + String(path ?? "");
    const rel = (name) =>
      mount && name.startsWith(mount) ? name.slice(mount.length) : name;
    const isText = (mimeType) => !mimeType || DRIVE_TEXT_MIME_RE.test(mimeType);

    return [
      {
        name: "list_files",
        label: "Listing files",
        description:
          'List files in this app\'s drive storage. An optional prefix such as "notes/" lists one path-like folder.',
        parameters: {
          type: "object",
          properties: {
            prefix: {
              type: "string",
              description: "Only list file paths beginning with this prefix.",
            },
          },
        },
        execute: async (p) => {
          const files = await drive.list({ prefix: full(p?.prefix ?? "") });
          if (!files.length) return "(no files)";
          return files
            .map(
              (f) =>
                rel(f.name) +
                " — " +
                (f.mimeType || "unknown type") +
                ", " +
                (f.size ?? 0) +
                " bytes, created " +
                (f.createdAt ?? "unknown"),
            )
            .join("\n");
        },
      },
      {
        name: "read_file",
        label: "Reading a file",
        description:
          "Read a file by path. Text files return content; binary files return metadata and a download URL.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path, e.g. notes/todo.md",
            },
          },
          required: ["path"],
        },
        execute: async (p) => {
          const file = await drive.stat(full(p.path));
          if (!file) return "File not found: " + p.path;
          if (!isText(file.mimeType)) {
            const url = await drive.url(file.cid);
            return (
              "[binary " +
              (file.mimeType || "unknown type") +
              ", " +
              (file.size ?? 0) +
              " bytes] url: " +
              url
            );
          }
          const content = await drive.read(full(p.path));
          if (content.length <= DRIVE_READ_TOOL_MAX_CHARS) return content;
          return (
            content.slice(0, DRIVE_READ_TOOL_MAX_CHARS) +
            "\n[truncated: file is " +
            content.length +
            " chars; showing the first " +
            DRIVE_READ_TOOL_MAX_CHARS +
            "]"
          );
        },
      },
      {
        name: "write_file",
        label: "Creating a file",
        description:
          "Create a new text file by path. Existing files are never overwritten.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "New file path, e.g. notes/todo.md",
            },
            content: {
              type: "string",
              description: "The new file's complete contents.",
            },
          },
          required: ["path", "content"],
        },
        execute: async (p) => {
          try {
            const file = await drive.write(
              full(p.path),
              String(p.content ?? ""),
            );
            return "Created " + p.path + " (" + (file.size ?? 0) + " bytes)";
          } catch (e) {
            if (e?.code === "maypop/conflict") {
              return "File already exists and was not changed: " + p.path;
            }
            throw e;
          }
        },
      },
      {
        name: "delete_file",
        label: "Deleting a file",
        description: "Delete a file by path.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path, e.g. notes/todo.md",
            },
          },
          required: ["path"],
        },
        execute: async (p) => {
          try {
            await drive.remove(full(p.path));
          } catch (e) {
            if (e?.code === "maypop/not-found")
              return "File not found: " + p.path;
            throw e;
          }
          return "Deleted " + p.path;
        },
      },
    ];
  }

  const agent = {
    /**
     * Create an in-app agent session. Resolves to the session once the runtime
     * has loaded. `config` is { systemPrompt, model?, tools?, chips?,
     * thinkingLevel?, conversationId? }. Throws when the viewer lacks `ai:use`.
     *
     * Pass `conversationId` to persist + resume the chat (await session.ready()
     * for the stored transcript); manage stored chats via `agent.conversations`.
     */
    async create(config) {
      await readyPromise;
      requireAi("use AI");
      const mod = await loadAgentModule();
      return mod.createAgentSession(config ?? {}, {
        apiBase: context.apiBase,
        getToken: () => (token ? token.token : null),
        can,
        // Chat-history persistence — backed by the per-viewer kv store above.
        loadConversation,
        saveConversation,
      });
    },
    /** Create/read/remove file tools backed by this app's storage. */
    driveTools,
    /** Stored chat history for the current viewer (list / get / delete). */
    conversations,
  };

  // -------------------------------------------------------------- notify ---
  // Send a push/bell notification to one or more group members. The backend
  // enforces rate limits per app instance and per recipient; over-limit calls
  // reject with Error("rate_limited"). Requires the notify:send scope — check
  // maypop.user.scopes before calling.
  /**
   * Send a notification to people who use this app. Requires the notify:send
   * scope (feature-detect via maypop.user.scopes). Recipients are member ids
   * from maypop.members(), or "all" for everyone in the app except the sender
   * — the same audience members() reports. Rate-limited per app instance and
   * per recipient; rejects with Error("rate_limited") when over.
   *
   * `path` (optional) deep-links into your app: the recipient opening the
   * notification lands on that site-relative path (e.g. `"/poll/7"`). Read it
   * back on open via `maypop.launchPath`; with a HashRouter your router picks
   * it up automatically.
   */
  async function notify(opts) {
    await readyPromise;
    if (!opts || typeof opts.title !== "string" || !opts.title.trim()) {
      throw new Error("notify: title is required");
    }
    var to =
      opts.to === "all" ? "all" : Array.isArray(opts.to) ? opts.to : null;
    if (to === null)
      throw new Error('notify: to must be "all" or an array of member ids');
    try {
      await api("POST", "/notify", {
        to: to,
        title: opts.title,
        body: opts.body,
        path: opts.path,
      });
    } catch (e) {
      // api() surfaces the 429 response body's "rate_limited" string as the
      // error message; map it to the documented rejection shape.
      if (e && e.message === "rate_limited") throw new Error("rate_limited");
      throw e;
    }
  }

  // --------------------------------------------------------------- surface
  window.maypop = Object.freeze({
    /** Resolves after the host handshake + identity load. Idempotent. */
    ready: () => readyPromise,

    get app() {
      return context
        ? {
            id: context.appId,
            // The same id, under the two names this SDK exposed before apps
            // had one. Deliberately absent from `v1.d.ts`: that file is what
            // the studio writes new apps against, and nothing new should
            // learn these. They stay at runtime forever, because bundles
            // built against them are immutable and still run.
            publicationId: context.appId,
            templateId: context.appId,
          }
        : null;
    },
    /** The current viewer (pseudonymous id). Available after ready(). */
    get user() {
      return me;
    },
    /** "read-write" | "read-only" */
    get mode() {
      return mode();
    },
    /**
     * Always `false`. Every surface that embeds an app hands it a real
     * session, so there is nothing to branch on — kept so apps built against
     * an older SDK, which could run session-less, still read a boolean.
     */
    get preview() {
      return false;
    },
    /** The host UI's theme ("light" | "dark"). Updates live — see "themechange". */
    get theme() {
      return theme ?? "dark";
    },
    /** Granted scopes, for capability sniffing. */
    get permissions() {
      return scopes();
    },
    /**
     * True when `mode` is "read-only" ONLY because nobody is signed in —
     * signing in through this same URL would make the session read-write.
     * False for a viewer who is already signed in, and for an app that is
     * read-only for everyone (nothing to unlock).
     *
     * Use it to turn a dead read-only state into an offer: show your save /
     * post / edit control and label it "Sign in to save", then call
     * `maypop.signIn()` from it.
     */
    get signInRequired() {
      return signInRequired;
    },
    /**
     * Ask the host to open its sign-in card. Returns immediately: signing in
     * re-mints the session and re-inits this app, so there is nothing here to
     * await.
     */
    signIn: requestSignIn,

    /**
     * The path this app was opened at, when launched from a deep-linked
     * notification (the `path` you passed to `maypop.notify`). `null` on a
     * normal open. Read it once at startup to route your initial screen —
     * with a HashRouter it is already applied as `location.hash`.
     */
    launchPath,

    kv,

    drive,

    ai,

    mcp,

    link,

    share,

    agent,

    /**
     * Everyone who can reach this app, with pseudonymous ids, roles, and
     * connected flags, plus a count of live anonymous share-link viewers:
     * { members: [{ id, username, role, avatarUrl, connected }], guestCount }.
     * Replaces maypop.group.members().
     */
    members: fetchMembers,

    /**
     * DEPRECATED namespace, kept only so published bundles keep running. A
     * group is launch context, not something an app belongs to, so none of
     * this describes the app any more:
     *   - info()    inert; a neutral { name: "Group" } placeholder
     *   - members() moved to maypop.members(), which this now aliases
     *   - openSettings() still works, but it is a host action about the
     *     group's own UI, not about this app
     * All of it is gone from v1.d.ts so new apps never learn it.
     */
    group: {
      info: fetchGroupInfo,
      members: fetchMembers,
      openSettings: openGroupSettings,
    },

    apps,

    multiplayer,

    notify,

    on(event, cb) {
      listeners[event]?.add(cb);
      return () => listeners[event]?.delete(cb);
    },
  });

  // Start the kv engine once identity is in.
  readyPromise.then(() => kv.start()).catch(() => {});
})();
