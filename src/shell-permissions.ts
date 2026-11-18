/**
 * The shell's side of an app's camera, microphone and location requests, for
 * a shell that is the top window of a browser tab (one the person opened, or
 * a popup the app opened onto its own shell address). The app's document
 * asks with `maypop:permission-request` and waits for
 * `maypop:permission-result`; the shell shows its card and replies.
 *
 * Allow and Don't allow last while the tab is open, reloads included: they
 * are kept in the tab's `sessionStorage` under the app's mount, so a tab the
 * person opens fresh asks again. A duplicated tab, or a popup the app opens
 * with `window.open` (which copies `sessionStorage`), keeps the answers: it
 * is the same app. Allow this time answers only the request on the card and
 * is never kept. The app shares
 * the shell's origin and could write that entry too, which is fine because
 * the card is the question the person answers before the browser's own
 * prompt, not a lock: an app that skips it reaches the browser directly.
 */

export type ShellFeature = "camera" | "microphone" | "geolocation";

/** The person's answer on the card: the tab's answer, or this request only. */
export type ShellChoice = "allow" | "once" | "block";

const SHELL_FEATURES: readonly ShellFeature[] = [
  "camera",
  "microphone",
  "geolocation",
];

/** The features of a request off the wire, dropping anything unknown. */
export function parseShellFeatures(value: unknown): ShellFeature[] {
  if (!Array.isArray(value)) return [];
  return SHELL_FEATURES.filter((feature) => value.includes(feature));
}

/**
 * One request. `from` is the window that asked, which gets the reply: frames
 * inside the app may reuse each other's ids. `document` is the document that
 * window showed when the request arrived. A frame keeps its window across
 * documents and each document numbers its ids from the start, so the reply
 * belongs to that document only.
 */
export interface ShellAsk<W = unknown> {
  from: W;
  document: unknown;
  id: string;
  features: ShellFeature[];
}

export interface ShellReply<W = unknown> extends ShellAsk<W> {
  granted: boolean;
}

export interface ShellPermissions<W = unknown> {
  decisions: Partial<Record<ShellFeature, "allow" | "block">>;
  /** Requests waiting for the person; the first is the one on the card. */
  asking: readonly ShellAsk<W>[];
}

export function noShellPermissions<W>(): ShellPermissions<W> {
  return { decisions: {}, asking: [] };
}

/**
 * `forget` drops the waiting requests `gone` picks, with no reply: the
 * documents that made them are gone. Answers given so far stay.
 */
export type ShellPermissionEvent<W = unknown> =
  | { type: "request"; ask: ShellAsk<W> }
  | { type: "answer"; choice: ShellChoice }
  | { type: "forget"; gone: (ask: ShellAsk<W>) => boolean };

/** The answer a request already has, or null when the person must be asked. */
function settled<W>(state: ShellPermissions<W>, ask: ShellAsk<W>): boolean | null {
  if (ask.features.length === 0) return false;
  if (ask.features.some((f) => state.decisions[f] === "block")) return false;
  if (ask.features.every((f) => state.decisions[f] === "allow")) return true;
  return null;
}

/**
 * Applies one event and says which requests it answers. Every request gets
 * exactly one reply: at once when its answer is known, otherwise when the
 * person answers it or an earlier question that covers it.
 */
export function shellPermissionStep<W>(
  state: ShellPermissions<W>,
  event: ShellPermissionEvent<W>,
): { state: ShellPermissions<W>; replies: ShellReply<W>[] } {
  if (event.type === "request") {
    const granted = settled(state, event.ask);
    if (granted !== null) {
      return { state, replies: [{ ...event.ask, granted }] };
    }
    return {
      state: { ...state, asking: [...state.asking, event.ask] },
      replies: [],
    };
  }
  if (event.type === "forget") {
    const asking = state.asking.filter((ask) => !event.gone(ask));
    return { state: { decisions: state.decisions, asking }, replies: [] };
  }
  const [answered, ...waiting] = state.asking;
  if (!answered) return { state, replies: [] };
  const decisions = { ...state.decisions };
  if (event.choice !== "once") {
    for (const feature of answered.features) decisions[feature] = event.choice;
  }
  const next: ShellPermissions<W> = { decisions, asking: [] };
  const granted = event.choice !== "block";
  const replies: ShellReply<W>[] = [{ ...answered, granted }];
  const asking: ShellAsk<W>[] = [];
  for (const ask of waiting) {
    const granted = settled(next, ask);
    if (granted === null) asking.push(ask);
    else replies.push({ ...ask, granted });
  }
  return { state: { decisions, asking }, replies };
}

/** The card's question for a request. */
export function shellPermissionQuestion(
  app: string,
  features: readonly ShellFeature[],
): string {
  const camera = features.includes("camera");
  const microphone = features.includes("microphone");
  if (features.includes("geolocation")) {
    return camera || microphone
      ? `Let ${app} use your camera, microphone and location?`
      : `Let ${app} know your location?`;
  }
  if (camera && microphone) return `Let ${app} use your camera and microphone?`;
  return camera ? `Let ${app} use your camera?` : `Let ${app} use your microphone?`;
}

/** The window properties `shellFrameAsks` walks. */
export interface ShellWindow {
  parent: unknown;
}

/**
 * Whether `source` is the app's frame (`app`) or a frame inside it, walking
 * up through parents. The shell (`shell`), its other frames and windows the
 * app opened or that opened the shell are refused.
 */
export function shellFrameAsks(
  source: unknown,
  app: unknown,
  shell: unknown,
): boolean {
  let win = source as ShellWindow | null | undefined;
  for (let depth = 0; win && depth < 32; depth++) {
    if (win === app) return true;
    if (win === shell || win.parent === win) return false;
    win = win.parent as ShellWindow | null | undefined;
  }
  return false;
}

/**
 * Whether the shell answers requests itself: only as the top window of a
 * browser tab. A shell framed by a Maypop page leaves the question to that
 * page (the app asks the top window, never the shell), and in the native
 * app the WebView answers.
 */
export function shellAsksForApp(win: {
  top: unknown;
  ReactNativeWebView?: unknown;
}): boolean {
  return win.top === win && !win.ReactNativeWebView;
}

/** The `Storage` methods the session keeps the tab's answers with. */
export interface ShellPermissionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORE_KEY = "maypop:shell-permissions";

type ShellDecisions = ShellPermissions["decisions"];

/**
 * The answers kept for this tab, or none when the store is missing,
 * unreadable or holds something else.
 */
function loadDecisions(
  store: (() => ShellPermissionStore | null | undefined) | undefined,
  key: string,
): ShellDecisions {
  try {
    const saved: unknown = JSON.parse(store?.()?.getItem(key) ?? "null");
    if (!saved || typeof saved !== "object") return {};
    const decisions: ShellDecisions = {};
    for (const feature of SHELL_FEATURES) {
      const value = (saved as Record<string, unknown>)[feature];
      if (value === "allow" || value === "block") decisions[feature] = value;
    }
    return decisions;
  } catch {
    return {};
  }
}

/** Keeps the tab's answers; a store that refuses leaves them in memory only. */
function saveDecisions(
  store: (() => ShellPermissionStore | null | undefined) | undefined,
  key: string,
  decisions: ShellDecisions,
): void {
  try {
    store?.()?.setItem(key, JSON.stringify(decisions));
  } catch {
    /* storage is full, blocked or gone */
  }
}

/** What the shell page gives `shellPermissionSession`. */
export interface ShellPermissionPage<W> {
  /** The app frame's window, if the frame exists. */
  app(): W | null | undefined;
  /** The shell's own window. */
  shell: W;
  /** Posts `maypop:permission-result` to `to`. */
  reply(to: W, id: string, granted: boolean): void;
  /**
   * The tab's `sessionStorage`, read on start and written on each answer.
   * Reading it may throw; without it answers last for this page load.
   */
  store?: () => ShellPermissionStore | null | undefined;
  /**
   * The app's mount path (`""` on its own origin). Apps mounted on paths of
   * one origin share its `sessionStorage`, so each keeps its answers apart.
   */
  scope?: string;
}

/**
 * The document `win` shows, or null when the shell can't read it (a
 * frame on another origin, or a sandbox without `allow-same-origin`).
 */
function documentOf(win: unknown): unknown {
  try {
    return (win as { document?: unknown } | null)?.document ?? null;
  } catch {
    return null;
  }
}

/**
 * The shell's requests and answers for one tab. A request belongs to the
 * window and the document that made it, and it is answered only while that
 * window is still inside the app and still shows that document. Requests
 * whose document is gone are dropped whenever the shell looks: on each
 * request, on each answer, and when the app frame loads (`prune`). So an
 * answer can never settle a later document's request with the same id, and
 * a request made while a document is still loading is kept.
 *
 * The document is read when the message arrives. If a frame posted a request
 * and loaded a new document before the shell handled it, the request counts
 * as the new document's; only a per-document id from the asking side would
 * tell those apart.
 */
export function shellPermissionSession<W>(page: ShellPermissionPage<W>) {
  const key = STORE_KEY + (page.scope ?? "");
  let state: ShellPermissions<W> = {
    decisions: loadDecisions(page.store, key),
    asking: [],
  };

  function inApp(win: W): boolean {
    return shellFrameAsks(win, page.app(), page.shell);
  }

  function live(ask: ShellAsk<W>): boolean {
    return inApp(ask.from) && documentOf(ask.from) === ask.document;
  }

  function apply(event: ShellPermissionEvent<W>): void {
    const step = shellPermissionStep(state, event);
    if (step.state.decisions !== state.decisions) {
      saveDecisions(page.store, key, step.state.decisions);
    }
    state = step.state;
    for (const reply of step.replies) {
      if (live(reply)) page.reply(reply.from, reply.id, reply.granted);
    }
  }

  function prune(): void {
    apply({ type: "forget", gone: (ask) => !live(ask) });
  }

  return {
    /**
     * Whether the shell answers `win`: a window inside the app whose
     * document the shell can read. Others get no `maypop:permission-host`.
     */
    hosts(win: W): boolean {
      return inApp(win) && documentOf(win) !== null;
    },

    /** The request on the card, if any. */
    shown(): ShellAsk<W> | null {
      return state.asking[0] ?? null;
    },

    request(from: W, id: string, features: unknown): void {
      const document = documentOf(from);
      if (!inApp(from) || document === null) return;
      prune();
      apply({
        type: "request",
        ask: { from, document, id, features: parseShellFeatures(features) },
      });
    },

    /**
     * The person's answer to `ask`, the question they saw. When that request
     * is gone the answer is dropped, so it can't land on the question that
     * replaces it on the card.
     */
    answer(ask: ShellAsk<W> | null, choice: ShellChoice): void {
      prune();
      if (!ask || state.asking[0] !== ask) return;
      apply({ type: "answer", choice });
    },

    prune,
  };
}
