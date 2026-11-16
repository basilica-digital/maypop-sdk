/**
 * The shell's side of an app's camera, microphone and location requests, for
 * a shell that is the top window of a browser tab (one the person opened, or
 * a popup the app opened onto its own shell address). The app's document
 * asks with `maypop:permission-request` and waits for
 * `maypop:permission-result`; the shell shows its card and replies.
 *
 * Answers last while the tab is open and are never stored: the app shares
 * the shell's origin, so anything the shell could save the app could write
 * too. The card is the question the person answers before the browser's
 * own prompt, not a lock: an app that skips it reaches the browser directly.
 */

export type ShellFeature = "camera" | "microphone" | "geolocation";

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
 * inside the app may reuse each other's ids.
 */
export interface ShellAsk<W = unknown> {
  from: W;
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
 * `reset` is the app frame loading a new document: the documents that asked
 * are gone, and a later document numbers its ids from the start again, so
 * an answer still queued for the old one would answer the new one's
 * question. Answers given so far stay.
 */
export type ShellPermissionEvent<W = unknown> =
  | { type: "request"; ask: ShellAsk<W> }
  | { type: "answer"; allow: boolean }
  | { type: "reset" };

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
  if (event.type === "reset") {
    return { state: { decisions: state.decisions, asking: [] }, replies: [] };
  }
  const [answered, ...waiting] = state.asking;
  if (!answered) return { state, replies: [] };
  const decisions = { ...state.decisions };
  for (const feature of answered.features) {
    decisions[feature] = event.allow ? "allow" : "block";
  }
  const next: ShellPermissions<W> = { decisions, asking: [] };
  const replies: ShellReply<W>[] = [{ ...answered, granted: event.allow }];
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
