import assert from "node:assert/strict";
import { test } from "node:test";

import {
  noShellPermissions,
  parseShellFeatures,
  shellAsksForApp,
  shellFrameAsks,
  shellPermissionSession,
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

// A tab's shell, its app frame and a frame inside the app, each showing a
// document, plus a session that records the replies it posts.
function tab() {
  const shell = { name: "shell" };
  shell.parent = shell;
  const app = { name: "app", parent: shell, document: { url: "about:blank" } };
  const nested = { name: "nested", parent: app, document: { url: "inner" } };
  const sent = [];
  const session = shellPermissionSession({
    app: () => app,
    shell,
    reply: (to, id, granted) => sent.push([to.name, id, granted]),
  });
  return { shell, app, nested, sent, session };
}

// The app frame keeps one window object across documents and every document
// numbers its ids from p1. An Allow on the old document's camera question,
// tapped after the new document asked for location with the same id but
// before the frame's load event, must not settle the location request.
test("an answer never reaches a later document in the same frame", () => {
  const { app, sent, session } = tab();
  app.document = { url: "first" };
  session.request(app, "p1", ["camera"]);
  const camera = session.shown();

  app.document = { url: "second" };
  session.request(app, "p1", ["geolocation"]);
  assert.deepEqual(session.shown().features, ["geolocation"]);

  session.answer(camera, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(session.shown().features, ["geolocation"]);

  session.answer(session.shown(), false);
  assert.deepEqual(sent, [["app", "p1", false]]);
});

// The same stale Allow with nothing queued behind it: it reaches no one, and
// it is not kept as the tab's answer for the camera.
test("an answer to a document that is gone is dropped", () => {
  const { app, sent, session } = tab();
  app.document = { url: "first" };
  session.request(app, "p1", ["camera"]);
  const camera = session.shown();

  app.document = { url: "second" };
  session.answer(camera, true);
  assert.deepEqual(sent, []);
  assert.equal(session.shown(), null);

  session.request(app, "p1", ["camera"]);
  assert.deepEqual(sent, []);
  assert.deepEqual(session.shown().features, ["camera"]);
});

// The frame's load event comes after the document has run its scripts and
// loaded its frames. A request the app or a frame inside it makes during
// startup, on the first load or a later one, must survive that event.
test("requests made before the app frame loads are kept", () => {
  const { app, nested, sent, session } = tab();
  app.document = { url: "app" };
  session.request(app, "p1", ["camera"]);
  session.request(nested, "p1", ["geolocation"]);
  session.prune();
  assert.deepEqual(session.shown().features, ["camera"]);

  session.answer(session.shown(), true);
  session.answer(session.shown(), true);
  assert.deepEqual(sent, [
    ["app", "p1", true],
    ["nested", "p1", true],
  ]);

  app.document = { url: "app again" };
  session.request(app, "p1", ["microphone"]);
  session.prune();
  session.answer(session.shown(), false);
  assert.deepEqual(sent.at(-1), ["app", "p1", false]);
});

// A frame removed from the app (its parent becomes null) and a frame whose
// document the shell can't read get no answer: the shell can't tell that
// frame's documents apart.
test("frames that left the app or can't be read are not answered", () => {
  const { app, nested, sent, session } = tab();
  session.request(nested, "p1", ["camera"]);
  nested.parent = null;
  session.answer(session.shown(), true);
  assert.deepEqual(sent, []);
  assert.equal(session.shown(), null);

  const foreign = { name: "foreign", parent: app };
  Object.defineProperty(foreign, "document", {
    get() {
      throw new Error("SecurityError");
    },
  });
  assert.equal(session.hosts(foreign), false);
  session.request(foreign, "p1", ["camera"]);
  assert.equal(session.shown(), null);
  assert.equal(session.hosts(app), true);
});

// Only the app frame and frames inside it may open the card and receive
// answers: the shell itself, its other frames, and popups or openers (top
// windows) are refused.
test("only the app frame and frames inside it are answered", () => {
  const shell = {};
  shell.parent = shell;
  const app = { parent: shell };
  const nested = { parent: app };
  const deeper = { parent: nested };
  const sibling = { parent: shell };
  const popup = {};
  popup.parent = popup;
  const popupFrame = { parent: popup };

  assert.equal(shellFrameAsks(app, app, shell), true);
  assert.equal(shellFrameAsks(nested, app, shell), true);
  assert.equal(shellFrameAsks(deeper, app, shell), true);
  assert.equal(shellFrameAsks(shell, app, shell), false);
  assert.equal(shellFrameAsks(sibling, app, shell), false);
  assert.equal(shellFrameAsks(popup, app, shell), false);
  assert.equal(shellFrameAsks(popupFrame, app, shell), false);
  assert.equal(shellFrameAsks(null, app, shell), false);
  assert.equal(shellFrameAsks(app, undefined, shell), false);
});
