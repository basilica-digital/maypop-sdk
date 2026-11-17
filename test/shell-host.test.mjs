import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const HOST_JS = await readFile(new URL("../dist/host.js", import.meta.url), "utf8");
const APP = "0b6f8d1e-3c1a-4a51-9f7e-2d4c8b0e9a11";

/** Answers any property read or call with itself: the page parts the boot path touches but these tests don't read. */
const inert = new Proxy(function () {}, {
  get: (_, key) => (key === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => inert,
  construct: () => inert,
});

function element(extra = {}) {
  return new Proxy(
    { hidden: false, textContent: "", children: [], append(c) { this.children.push(c); }, ...extra },
    { get: (t, k) => (k in t ? t[k] : inert) },
  );
}

/**
 * Runs the built shell host in a page with `fetch` given. Returns the status
 * line, what the app frame's port received, and a way to send it messages.
 */
function shellPage({ fetch, nativeView }) {
  const status = element();
  const port = { onmessage: null, sent: [], postMessage(m) { this.sent.push(m); } };
  const frame = element({
    contentWindow: { postMessage() {} },
    addEventListener() {},
  });
  const elements = { status, app: frame };
  const document = new Proxy(
    {
      getElementById: (id) => elements[id] ?? null,
      createElement: () => ({}),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    { get: (t, k) => (k in t ? t[k] : inert) },
  );
  const window = {
    __MAYPOP_SHELL__: {
      apiBase: "https://api.maypop.example",
      mount: "",
      maypopOrigin: "https://maypop.example",
      appId: APP,
    },
    location: { href: "https://app.example/_maypop/shell", search: "", origin: "https://app.example" },
    document,
    navigator: { userAgent: "test" },
    top: {},
    ReactNativeWebView: nativeView,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    getComputedStyle: () => ({ paddingTop: "0" }),
    screen: { width: 390, height: 844 },
    innerHeight: 844,
    history: { replaceState() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    MessageChannel: function () {
      this.port1 = port;
      this.port2 = {};
    },
    fetch,
    console: { error() {}, warn() {}, log() {} },
    URL,
    URLSearchParams,
    Response,
    Promise,
    JSON,
  };
  window.window = window;
  window.self = window;
  vm.runInNewContext(HOST_JS, window);
  return { status, port };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A web tab opened onto the shell address has no cookie, so the shell's
// access request is refused. The page must link to the app in Maypop, not
// ask the person to scan a code.
test("the shell on the web without a session links to the app in Maypop", async () => {
  const { status } = shellPage({
    fetch: async (url) =>
      String(url).includes("/_maypop/session/access")
        ? new Response(null, { status: 401 })
        : new Response(null, { status: 404 }),
  });
  await settle();
  assert.equal(status.hidden, false);
  assert.doesNotMatch(status.textContent, /scan/i);
  assert.equal(status.children.length, 1);
  assert.equal(status.children[0].href, `https://maypop.example/app/${APP}`);
});

// The native app view hides the shell's status line and recovers from a
// refused session itself: its tap on the shell's own access request reports
// `access-lost`. A refresh the server refuses must go through that request,
// and the app must hear `maypop:revoked`, or the person stays on a dead app.
test("a refused refresh in the native app view reaches the native host", async () => {
  const toNative = [];
  const server = async (url) => {
    if (String(url).includes("/_maypop/session/access")) {
      return new Response(null, { status: 401 });
    }
    return new Response(null, { status: 404 });
  };
  // Modelled on the native app view's tap: the first access request gets
  // the session the view minted, later ones go to the server.
  let answered = false;
  const tap = async (input, init) => {
    const url = String(input);
    if (!url.includes("/_maypop/session/access")) return server(input, init);
    if (!answered) {
      answered = true;
      return json({ sessionId: "s", token: "t", expiresIn: 3600, scopes: [], appId: APP, appName: "App" });
    }
    const res = await server(input, init);
    if (res.status >= 400 && res.status < 500) {
      toNative.push({ type: "access-lost" });
    }
    return res;
  };
  const { status, port } = shellPage({
    fetch: tap,
    nativeView: { postMessage: (m) => toNative.push(JSON.parse(m)) },
  });
  await settle();
  assert.equal(typeof port.onmessage, "function", "the shell offered the app its port");

  port.onmessage({ data: { type: "maypop:refresh" } });
  await settle();
  assert.deepEqual(toNative, [{ type: "access-lost" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(port.sent)), [{ type: "maypop:revoked" }]);
  // Nothing the view hides is offered as the way out.
  assert.doesNotMatch(status.textContent, /expired|scan/i);
});
