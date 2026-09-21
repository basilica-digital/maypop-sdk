import "./runtime.js";
import type { MaypopSdk } from "./v1.js";

export type Maypop = MaypopSdk;

const browserOnly = (): never => {
  throw new Error(
    "@basilica-digital/maypop-sdk is available in the browser after the Maypop host initializes it",
  );
};

const unavailableMaypop = new Proxy(Object.create(null) as Maypop, {
  get: browserOnly,
  set: browserOnly,
});

/** Return the SDK installed in the current browser window. */
export function getMaypop(): Maypop {
  if (typeof window === "undefined" || !window.maypop) browserOnly();
  return window.maypop;
}

/** The same SDK object exposed as `window.maypop` by the hosted script. */
export const maypop: Maypop =
  typeof window === "undefined" ? unavailableMaypop : getMaypop();

export default maypop;
