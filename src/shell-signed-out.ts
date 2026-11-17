/**
 * What the shell shows when it has no session to open the app with.
 *
 * Only the native app view and a code scanned from a computer give the
 * shell its session cookie. On the web a tab or popup opened onto the shell
 * address has none, so the useful thing to offer is the app's page in
 * Maypop.
 *
 * Inside the native app view the shell shows nothing: that view hides the
 * shell's status line, and it learns of a refused session itself, from the
 * shell's request to `/_maypop/session/access`, and takes the app down.
 */

export interface ShellSignedOut {
  message: string;
  /** Where "Open this app in Maypop" goes, when the shell knows. */
  open: { label: string; href: string } | null;
}

/**
 * The app's page on Maypop's own origin, or null when the page that served
 * the shell didn't say where that is (a placeholder left unfilled, or a
 * value that isn't an http(s) origin and an app id).
 */
export function maypopAppUrl(origin: unknown, appId: unknown): string | null {
  if (typeof origin !== "string" || typeof appId !== "string") return null;
  if (!/^[0-9A-Za-z-]+$/.test(appId)) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  return new URL(`/app/${appId}`, base.origin).href;
}

/**
 * `expired` is true when the shell had a session this visit and lost it;
 * at boot the shell can't tell a missing cookie from a revoked one.
 */
export function shellSignedOut(options: {
  native: boolean;
  expired: boolean;
  appUrl: string | null;
}): ShellSignedOut | null {
  if (options.native) return null;
  const open = options.appUrl
    ? { label: "Open this app in Maypop", href: options.appUrl }
    : null;
  if (options.expired) {
    return {
      message: open ? "Session expired." : "Session expired. Open this app again in Maypop.",
      open,
    };
  }
  return {
    message: open
      ? "This app opens inside Maypop."
      : "This app opens inside Maypop. Open it from Maypop to use it.",
    open,
  };
}
