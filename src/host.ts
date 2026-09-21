// @ts-nocheck -- The shell host is compiled as an isolated browser script.
/**
 * Maypop apps-origin mini-host shell.
 *
 * Trusted control plane on `{appId}.<apps host>/_maypop/shell`.
 * Holds short-lived access tokens in memory and runs the MessagePort
 * handshake (`maypop:init` / refresh / token / revoked). The long-lived
 * refresh credential is an HttpOnly cookie (`maypop_rt`, Path=/_maypop) so:
 *   - full page reload restores the session
 *   - untrusted app JS at `/` cannot read it (path + HttpOnly)
 *
 * Boot:
 *   1. `?b=` bootstrap → API mints session → store refresh in cookie
 *   2. Or cookie already set → POST /_maypop/session/access
 *   3. GET `/_maypop/revision`, then iframe `/?v={cid}&shell=1` + handshake
 *   4. Poll `/_maypop/revision` for app content updates
 *   5. Soft install nudge
 */
(() => {
  const cfg = window.__MAYPOP_SHELL__;
  if (!cfg || !cfg.apiBase) {
    console.error("[maypop:shell] missing __MAYPOP_SHELL__ config");
    return;
  }

  // Subdomain hosts: ""; path mounts: "/__app/{label}" (no trailing slash).
  const mount =
    typeof cfg.mount === "string" ? cfg.mount.replace(/\/$/, "") : "";
  /** Absolute path under this app mount (`p` must start with `/`). */
  function appPath(p) {
    return mount + p;
  }

  /** Iframe document URL: `v` is the CDN cache token for the live cid. */
  function iframeSrcForRevision(cid) {
    if (cid) {
      return appPath("/?v=" + encodeURIComponent(cid) + "&shell=1");
    }
    return appPath("/?shell=1");
  }

  // Access token + context only — never the refresh token (that's in the cookie).
  let liveSession = null;

  const statusEl = document.getElementById("status");
  const frame = document.getElementById("app");
  const frameHost = document.getElementById("frame-host");
  const installEl = document.getElementById("install");
  const installBtn = document.getElementById("install-btn");
  const installDismiss = document.getElementById("install-dismiss");

  function setStatus(msg) {
    if (!statusEl) return;
    const text = msg || "";
    statusEl.textContent = text;
    // Empty text still paints an inset:0 overlay (z-index above the iframe);
    // hide the node so "Opening…" can't stick over a loaded app forever.
    statusEl.hidden = !text;
  }

  function deviceLabel() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
    if (/Android/i.test(ua)) return "Android";
    return "Phone";
  }

  function clearBootstrapFromUrl() {
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.has("b")) {
        u.searchParams.delete("b");
        history.replaceState(null, "", u.pathname + u.search + u.hash);
      }
    } catch {
      /* ignore */
    }
  }

  async function bootstrap(token) {
    const res = await fetch(`${cfg.apiBase}/handoffs/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrapToken: token,
        deviceLabel: deviceLabel(),
      }),
    });
    if (!res.ok) {
      const detail = await res
        .json()
        .then((b) => b?.error)
        .catch(() => null);
      throw new Error(detail || `bootstrap failed (${res.status})`);
    }
    return res.json();
  }

  /** Persist refresh token as HttpOnly Path=/_maypop cookie (not readable by app JS). */
  async function storeRefreshCookie(refreshToken) {
    const res = await fetch(appPath("/_maypop/session"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      throw new Error(`could not persist session (${res.status})`);
    }
  }

  /**
   * Cookie → short-lived access token + init context.
   * @returns {{ kind: 'ok', session: object } | { kind: 'revoked' } | { kind: 'transient' }}
   */
  async function accessFromCookie() {
    let res;
    try {
      res = await fetch(appPath("/_maypop/session/access"), {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      return { kind: "transient" };
    }
    if (res.ok) {
      try {
        const data = await res.json();
        return {
          kind: "ok",
          session: {
            sessionId: data.sessionId,
            token: data.token,
            expiresIn: data.expiresIn,
            scopes: data.scopes,
            appId: data.appId,
            appName: data.appName,
          },
        };
      } catch {
        return { kind: "transient" };
      }
    }
    if (res.status >= 400 && res.status < 500) return { kind: "revoked" };
    return { kind: "transient" };
  }

  // ── handshake (mirrors frontend use-maypop-app-session) ─────────────────

  const INIT_FAST_MS = 300;
  const INIT_SLOW_MS = 1000;
  const INIT_FAST_ATTEMPTS = 20;
  const INIT_DEADLINE_MS = 30_000;
  const INIT_KEEPALIVE_MS = 5000;

  const THEME_BG = { light: "#f6f3f0", dark: "#08090b" };

  function osTheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  /** Keep browser title bar / status bar / color-scheme in sync with OS. */
  function applyChromeTheme(theme) {
    const t = theme === "dark" ? "dark" : "light";
    const bg = THEME_BG[t];
    const root = document.documentElement;
    root.style.colorScheme = t;
    root.style.backgroundColor = bg;
    // Dual media theme-color metas already track OS; keep contents in sync
    // for browsers that ignore media on theme-color.
    for (const meta of document.querySelectorAll(
      'meta[name="theme-color"]',
    )) {
      const media = meta.getAttribute("media");
      if (
        !media ||
        (t === "dark" && media.includes("dark")) ||
        (t === "light" && media.includes("light"))
      ) {
        meta.setAttribute("content", bg);
      }
    }
    const apple = document.querySelector(
      'meta[name="apple-mobile-web-app-status-bar-style"]',
    );
    // Match main Maypop PWA + shell.html boot script: solid dark bar.
    if (apple) {
      apple.setAttribute("content", t === "dark" ? "black" : "default");
    }
  }

  function postTheme() {
    const theme = osTheme();
    applyChromeTheme(theme);
    if (!frame?.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        { type: "maypop:theme", theme },
        window.location.origin,
      );
    } catch {
      /* ignore */
    }
  }

  // Follow OS light/dark changes live (title bar + iframe).
  try {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", postTheme);
  } catch {
    /* older Safari */
  }
  applyChromeTheme(osTheme());

  function startHandshake(session) {
    let port = null;
    let attempt = 0;
    let startedAt = Date.now();
    let timer = null;
    // Single proactive-refresh handle for this handshake — cleared before
    // each new maypop:ready so iframe reloads don't stack orphaned loops.
    let refreshTimer = null;
    let alive = true;

    // One id. The two legacy names an app reads — `maypop.app.publicationId`
    // and `.templateId` — are produced by the SDK's own getter in `v1.js`,
    // filled from `appId`; they never came from this message. The web host
    // stopped sending them here and every app kept working, which is the
    // evidence that nothing on the supported path reads the raw context.
    const context = {
      appId: session.appId,
      apiBase: cfg.apiBase,
    };

    function clearRefreshTimer() {
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    }

    function postInit() {
      if (!alive || !frame?.contentWindow) return;
      const channel = new MessageChannel();
      const tokenMsg = {
        token: session.token,
        expiresIn: session.expiresIn,
        scopes: session.scopes,
      };
      try {
        frame.contentWindow.postMessage(
          { type: "maypop:init", context, token: tokenMsg },
          window.location.origin,
          [channel.port2],
        );
        postTheme();
      } catch (err) {
        console.warn("[maypop:shell] postMessage failed", err);
        return;
      }

      channel.port1.onmessage = (ev) => {
        const data = ev.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "maypop:ready") {
          if (port && port !== channel.port1) {
            try {
              port.close();
            } catch {
              /* ignore */
            }
          }
          port = channel.port1;
          setStatus("");
          serveRefreshes(port, session);
          return;
        }
        if (data.type === "maypop:refresh") {
          void handleRefresh(channel.port1, session);
        }
      };
    }

    function schedule() {
      if (!alive) return;
      const elapsed = Date.now() - startedAt;
      let delay;
      if (attempt < INIT_FAST_ATTEMPTS) delay = INIT_FAST_MS;
      else if (elapsed < INIT_DEADLINE_MS) delay = INIT_SLOW_MS;
      else delay = INIT_KEEPALIVE_MS;
      timer = setTimeout(() => {
        attempt += 1;
        postInit();
        schedule();
      }, delay);
    }

    window.addEventListener("message", (ev) => {
      if (ev.source !== frame?.contentWindow) return;
      if (ev.data?.type === "maypop:hello") {
        attempt = 0;
        startedAt = Date.now();
        if (timer) clearTimeout(timer);
        postInit();
        schedule();
      }
    });

    frame.addEventListener("load", () => {
      attempt = 0;
      startedAt = Date.now();
      if (timer) clearTimeout(timer);
      postInit();
      schedule();
      // Static apps (no window.maypop) never send maypop:ready — don't leave
      // "Opening…" over a painted iframe. SDK apps clear earlier on ready.
      setStatus("");
    });

    function serveRefreshes(port, session) {
      clearRefreshTimer();
      port.onmessage = (ev) => {
        if (ev.data?.type === "maypop:refresh") {
          void handleRefresh(port, session);
        }
      };
      const scheduleRefresh = () => {
        const ms = Math.max((session.expiresIn - 60) * 1000, 5000);
        refreshTimer = setTimeout(async () => {
          await handleRefresh(port, session);
          if (alive) scheduleRefresh();
        }, ms);
      };
      scheduleRefresh();
    }

    postInit();
    schedule();
  }

  async function handleRefresh(port, session) {
    const result = await accessFromCookie();
    if (result.kind === "ok") {
      session.token = result.session.token;
      session.expiresIn = result.session.expiresIn;
      session.scopes = result.session.scopes;
      liveSession = session;
      try {
        port.postMessage({
          type: "maypop:token",
          token: result.session.token,
          expiresIn: result.session.expiresIn,
          scopes: result.session.scopes,
        });
      } catch {
        /* closed */
      }
      return;
    }
    if (result.kind === "revoked") {
      try {
        port.postMessage({ type: "maypop:revoked" });
      } catch {
        /* closed */
      }
      liveSession = null;
      setStatus("Session expired. Scan the code again from your computer.");
    }
  }

  // ── app content update check ────────────────────────────────────────────
  // Mirrors the group app viewer's "new version available" toast, without
  // Replicache: poll /_maypop/revision for the publication's contentCid and
  // prompt the user to reload when it moves. Same schedule shape as the main
  // SPA's version-check (interval + focus/visibility, snooze on dismiss).

  const UPDATE_CHECK_INTERVAL_MS = 60_000;
  const UPDATE_WAKE_CHECK_GAP_MS = 30_000;

  const updateEl = document.getElementById("update");
  const updateBtn = document.getElementById("update-btn");
  const updateDismiss = document.getElementById("update-dismiss");

  let updateCheckInFlight = false;
  let lastUpdateCheckAt = 0;
  // contentCid the shell is currently serving (first successful poll).
  let committedContentCid = null;
  // Newest contentCid seen that differs from committed; null until a mismatch.
  let latestContentCid = null;
  // contentCid the user dismissed — don't re-prompt for the same one.
  let snoozedContentCid = null;

  function showUpdateBanner() {
    if (
      latestContentCid !== null &&
      latestContentCid === snoozedContentCid
    ) {
      return;
    }
    if (updateEl) updateEl.hidden = false;
  }

  function dismissUpdateBanner() {
    snoozedContentCid = latestContentCid ?? "unknown";
    if (updateEl) updateEl.hidden = true;
  }

  async function checkForAppUpdate() {
    if (updateCheckInFlight) return;
    updateCheckInFlight = true;
    lastUpdateCheckAt = Date.now();
    try {
      const res = await fetch(appPath("/_maypop/revision"), {
        cache: "no-store",
      });
      if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
        return;
      }
      const data = await res.json();
      const contentCid =
        typeof data.contentCid === "string" ? data.contentCid : null;
      if (!contentCid) return;
      // First successful read establishes the baseline — no prompt.
      if (committedContentCid === null) {
        committedContentCid = contentCid;
        return;
      }
      if (contentCid === committedContentCid) {
        latestContentCid = null;
        if (updateEl) updateEl.hidden = true;
        return;
      }
      latestContentCid = contentCid;
      showUpdateBanner();
    } catch {
      // Offline / fetch failure is never an update signal.
    } finally {
      updateCheckInFlight = false;
    }
  }

  function checkForAppUpdateOnWake() {
    if (Date.now() - lastUpdateCheckAt < UPDATE_WAKE_CHECK_GAP_MS) return;
    void checkForAppUpdate();
  }

  function startUpdateCheck() {
    window.setInterval(
      () => void checkForAppUpdate(),
      UPDATE_CHECK_INTERVAL_MS,
    );
    window.addEventListener("focus", checkForAppUpdateOnWake);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForAppUpdateOnWake();
    });
    // Baseline shortly after boot so a long-lived PWA that resumes mid-session
    // still catches a deploy that landed while it was backgrounded.
    window.setTimeout(() => void checkForAppUpdate(), 5_000);
  }

  if (updateBtn) {
    updateBtn.addEventListener("click", () => {
      const cid = latestContentCid;
      if (cid && frame) {
        committedContentCid = cid;
        latestContentCid = null;
        if (updateEl) updateEl.hidden = true;
        frame.src = iframeSrcForRevision(cid);
        return;
      }
      window.location.reload();
    });
  }
  if (updateDismiss) {
    updateDismiss.addEventListener("click", dismissUpdateBanner);
  }

  // ── install prompt ──────────────────────────────────────────────────────

  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (installEl) installEl.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (deferredInstall) {
        deferredInstall.prompt();
        await deferredInstall.userChoice.catch(() => {});
        deferredInstall = null;
        if (installEl) installEl.hidden = true;
        return;
      }
      const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isIos && installEl) {
        installEl.querySelector("[data-ios]")?.removeAttribute("hidden");
      }
    });
  }
  if (installDismiss) {
    installDismiss.addEventListener("click", () => {
      if (installEl) installEl.hidden = true;
    });
  }

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (standalone && installEl) installEl.hidden = true;

  // ── layout ──────────────────────────────────────────────────────────────
  // iOS standalone PWAs: 100vh / 100dvh under-report and leave a black gap
  // above the home indicator. Set --shell-height from the real visible
  // height (innerHeight, or visualViewport in browser tabs). CSS pads the
  // host by env(safe-area-inset-*) so shell-bg fills notch/home-indicator
  // and the iframe never paints under them — same contract as Maypop's
  // mobile shell (global-layout + fullscreen app overlay).
  function isStandaloneDisplay() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      window.navigator.standalone === true
    );
  }

  /** env(safe-area-inset-top) as resolved px — frame-host's padding-top. */
  function resolvedSafeAreaTop() {
    if (!frameHost) return 0;
    const v = parseFloat(window.getComputedStyle(frameHost).paddingTop);
    return Number.isFinite(v) ? v : 0;
  }

  function layoutAppFrame() {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let top = 0;
    let height;
    if (isStandaloneDisplay() || !vv) {
      height = window.innerHeight;
      // iOS web clips installed while the shell advertised
      // "black-translucent" keep it forever (the meta is snapshotted at
      // Add-to-Home-Screen). In that full-bleed mode WebKit's layout
      // viewport — and innerHeight — under-report by roughly status bar +
      // home indicator: the black strip. The webview truly covers the
      // screen there (safe-area-inset-top > 0 is the tell; inset webviews
      // report 0), so size from the physical screen instead.
      if (window.navigator.standalone === true && resolvedSafeAreaTop() > 0) {
        const landscape = window.matchMedia("(orientation: landscape)").matches;
        const screenH = landscape
          ? Math.min(window.screen.width, window.screen.height)
          : Math.max(window.screen.width, window.screen.height);
        if (Number.isFinite(screenH)) height = Math.max(height, screenH);
      }
    } else {
      // Browser tab: follow the visual viewport (URL/toolbars).
      top = vv.offsetTop;
      height = vv.height;
    }
    root.style.setProperty("--shell-height", `${Math.round(height)}px`);
    if (frameHost) {
      frameHost.style.top = `${Math.round(top)}px`;
    }
    renderLayoutDebug(height);
  }

  // ?shellDebug=1 → on-device geometry readout (this bug class is only
  // reproducible on installed phone PWAs, where there's no devtools).
  const layoutDebugEl = (() => {
    if (!new URLSearchParams(window.location.search).has("shellDebug")) {
      return null;
    }
    const el = document.createElement("pre");
    el.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:9;margin:0;padding:6px 8px;" +
      "font:11px/1.4 ui-monospace,monospace;background:rgba(0,0,0,0.7);" +
      "color:#4ade80;border-radius:8px;pointer-events:none;white-space:pre;";
    document.body.appendChild(el);
    return el;
  })();

  function renderLayoutDebug(height) {
    if (!layoutDebugEl) return;
    const vv = window.visualViewport;
    layoutDebugEl.textContent = [
      `shell-height ${Math.round(height)}`,
      `innerH ${window.innerHeight} screen ${window.screen.width}x${window.screen.height}`,
      `vv ${vv ? `${Math.round(vv.height)}@${Math.round(vv.offsetTop)}` : "n/a"}`,
      `sat ${resolvedSafeAreaTop()} standalone ${isStandaloneDisplay()} navStandalone ${window.navigator.standalone === true}`,
    ].join("\n");
  }

  layoutAppFrame();
  window.addEventListener("resize", layoutAppFrame);
  // PWA resume / bfcache restore / launch-time geometry settling on iOS can
  // move innerHeight without a resize event.
  window.addEventListener("pageshow", layoutAppFrame);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") layoutAppFrame();
  });
  window.addEventListener("load", () => {
    window.setTimeout(layoutAppFrame, 100);
  });
  window.addEventListener("orientationchange", () => {
    // iOS fires orientationchange before innerHeight settles.
    window.setTimeout(layoutAppFrame, 100);
    window.setTimeout(layoutAppFrame, 300);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", layoutAppFrame);
    window.visualViewport.addEventListener("scroll", layoutAppFrame);
  }
  try {
    window
      .matchMedia("(display-mode: standalone)")
      .addEventListener("change", layoutAppFrame);
  } catch {
    /* older browsers */
  }

  // ── boot ────────────────────────────────────────────────────────────────

  async function boot() {
    setStatus("Opening…");
    const params = new URLSearchParams(window.location.search);
    const bootstrapToken = params.get("b");

    let session = null;

    if (bootstrapToken) {
      try {
        const data = await bootstrap(bootstrapToken);
        clearBootstrapFromUrl();
        // Cookie first so a reload mid-handshake still restores.
        await storeRefreshCookie(data.refreshToken);
        session = {
          sessionId: data.sessionId,
          token: data.token,
          expiresIn: data.expiresIn,
          scopes: data.scopes,
          appId: data.appId,
          appName: data.appName,
        };
        liveSession = session;
        if (data.appName) document.title = data.appName;
      } catch (err) {
        console.error("[maypop:shell] bootstrap", err);
        setStatus(err.message || "Could not open app. Try scanning again.");
        return;
      }
    } else {
      const result = await accessFromCookie();
      if (result.kind === "ok") {
        session = result.session;
        liveSession = session;
        if (session.appName) document.title = session.appName;
      } else if (result.kind === "revoked") {
        setStatus("Session expired. Scan the code again from your computer.");
        return;
      } else {
        // No cookie yet vs network blip.
        setStatus("No session. Open the link from your computer’s QR code.");
        return;
      }
    }

    let bootCid = null;
    try {
      const res = await fetch(appPath("/_maypop/revision"), {
        cache: "no-store",
      });
      if (res.ok && res.headers.get("content-type")?.includes("json")) {
        const data = await res.json();
        if (typeof data.contentCid === "string" && data.contentCid) {
          bootCid = data.contentCid;
          committedContentCid = bootCid;
        }
      }
    } catch {
      // Bare `/?shell=1` is origin no-store when apps CDN is on.
    }

    frame.hidden = false;
    frame.src = iframeSrcForRevision(bootCid);
    startHandshake(session);
    startUpdateCheck();

    if (!standalone) {
      setTimeout(() => {
        if (
          installEl &&
          (deferredInstall || /iPhone|iPad|iPod/i.test(navigator.userAgent))
        ) {
          installEl.hidden = false;
        }
      }, 4000);
    }
  }

  void boot();
})();
