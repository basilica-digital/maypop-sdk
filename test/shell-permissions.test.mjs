import assert from "node:assert/strict";
import { test } from "node:test";

import {
  noShellPermissions,
  parseShellFeatures,
  shellAsksForApp,
  shellPermissionStep,
} from "../src/shell-permissions.ts";

function request(state, from, id, features) {
  return shellPermissionStep(state, {
    type: "request",
    ask: { from, id, features: parseShellFeatures(features) },
  });
}

// A popup the app opens onto its shell address is a tab's top window with no
// card unless the shell itself answers; framed or native shells must stay
// silent so the page or WebView above them asks instead.
test("the shell answers only as a browser tab's top window", () => {
  const tab = {};
  tab.top = tab;
  assert.equal(shellAsksForApp(tab), true);

  const framed = { top: {} };
  assert.equal(shellAsksForApp(framed), false);

  const native = { ReactNativeWebView: {} };
  native.top = native;
  assert.equal(shellAsksForApp(native), false);
});

// Every request gets exactly one reply: a second request for a feature on
// the card waits for the answer rather than opening another card, and the
// reply goes back to the frame that asked, since frames reuse ids.
test("requests wait for the card and are answered back to their frame", () => {
  const app = { name: "app" };
  const inner = { name: "inner" };
  let step = request(noShellPermissions(), app, "p1", ["geolocation"]);
  assert.deepEqual(step.replies, []);
  step = request(step.state, inner, "p1", ["geolocation"]);
  assert.deepEqual(step.replies, []);
  assert.equal(step.state.asking.length, 2);

  step = shellPermissionStep(step.state, { type: "answer", allow: false });
  assert.deepEqual(
    step.replies.map((r) => [r.from, r.id, r.granted]),
    [
      [app, "p1", false],
      [inner, "p1", false],
    ],
  );
  assert.equal(step.state.asking.length, 0);

  // A blocked feature is refused at once while the tab stays open.
  step = request(step.state, app, "p2", ["camera", "geolocation"]);
  assert.deepEqual(
    step.replies.map((r) => r.granted),
    [false],
  );
});

// An allowed feature is not asked again, but a request adding a feature the
// person hasn't answered shows the card; unknown features are never granted.
test("an answer covers only the features it was asked for", () => {
  const app = {};
  let step = request(noShellPermissions(), app, "p1", ["camera"]);
  step = shellPermissionStep(step.state, { type: "answer", allow: true });
  assert.equal(step.replies[0].granted, true);

  step = request(step.state, app, "p2", ["camera"]);
  assert.equal(step.replies[0].granted, true);

  step = request(step.state, app, "p3", ["camera", "microphone"]);
  assert.deepEqual(step.replies, []);
  assert.equal(step.state.asking.length, 1);

  step = request(step.state, app, "p4", ["clipboard-read"]);
  assert.deepEqual(
    step.replies.map((r) => [r.id, r.granted]),
    [["p4", false]],
  );
});
