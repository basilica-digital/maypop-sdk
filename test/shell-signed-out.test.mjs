import assert from "node:assert/strict";
import { test } from "node:test";

import { maypopAppUrl, shellSignedOut } from "../src/shell-signed-out.ts";

const APP = "0b6f8d1e-3c1a-4a51-9f7e-2d4c8b0e9a11";

// A web tab opened onto the shell address has no session cookie. It must
// send the person to the app's page in Maypop, not ask them to scan a code
// from a computer they may be sitting at.
test("a web tab without a session links to the app in Maypop", () => {
  const view = shellSignedOut({
    native: false,
    expired: false,
    appUrl: maypopAppUrl("https://maypop.example", APP),
  });
  assert.deepEqual(view.open, {
    label: "Open this app in Maypop",
    href: `https://maypop.example/app/${APP}`,
  });
  assert.doesNotMatch(view.message, /scan|expired/i);
});

// A session lost during the visit on the web is reported as expired, with
// the way back to the app. The native app view shows nothing from the
// shell: it hides the shell's status line and recovers on its own.
test("an ended session says so on the web and is left to the native app", () => {
  const web = shellSignedOut({
    native: false,
    expired: true,
    appUrl: `https://maypop.example/app/${APP}`,
  });
  assert.match(web.message, /^Session expired\./);
  assert.equal(web.open?.href, `https://maypop.example/app/${APP}`);

  assert.equal(
    shellSignedOut({ native: true, expired: true, appUrl: web.open.href }),
    null,
  );
});

// A backend that serves this shell without filling the new placeholders
// leaves `{{…}}` in the config; that must show no link rather than a link
// to a relative `{{MAYPOP_ORIGIN}}` path. Only http(s) origins are linked,
// and only the origin of the configured value is kept.
test("the Maypop link needs a filled-in origin and app id", () => {
  assert.equal(maypopAppUrl("{{MAYPOP_ORIGIN}}", "{{APP_ID}}"), null);
  assert.equal(maypopAppUrl("https://maypop.example", "{{APP_ID}}"), null);
  assert.equal(maypopAppUrl("javascript:alert(1)", APP), null);
  assert.equal(maypopAppUrl(undefined, APP), null);
  assert.equal(maypopAppUrl("https://maypop.example", "../admin"), null);
  assert.equal(
    maypopAppUrl("http://localhost:1520/some/path", APP),
    `http://localhost:1520/app/${APP}`,
  );

  const view = shellSignedOut({ native: false, expired: false, appUrl: null });
  assert.equal(view.open, null);
  assert.match(view.message, /Maypop/);
});
