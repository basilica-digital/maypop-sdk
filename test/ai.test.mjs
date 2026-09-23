import assert from "node:assert/strict";
import { test } from "node:test";

// Boots the hosted runtime under a fake window, hands it a host init message,
// and stubs `fetch` so `maypop.ai.decide()` can be asserted end to end: the
// request it sends, and how it maps the backend's answers.

const API_BASE = "http://api.test";
const SESSION = "app-token";

const listeners = new Map();
const window = {
  addEventListener(type, fn) {
    listeners.set(type, fn);
  },
};
window.parent = window;

Object.defineProperties(globalThis, {
  document: {
    configurable: true,
    value: {
      addEventListener() {},
      documentElement: { dataset: {}, style: {} },
      visibilityState: "visible",
    },
  },
  location: { configurable: true, value: { hash: "" } },
  navigator: { configurable: true, value: {} },
  window: { configurable: true, value: window },
});

// The runtime schedules a token refresh for a minute before expiry. In a
// browser that is harmless; here it would keep the test process alive, so
// timers must not hold the event loop open.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = realSetTimeout(fn, ms, ...args);
  timer.unref?.();
  return timer;
};

const calls = [];
let respond = () => new Response("{}", { status: 200 });
globalThis.fetch = async (url, init) => {
  const call = { url, method: init?.method, headers: init?.headers, body: init?.body };
  calls.push(call);
  if (url === `${API_BASE}/app-api/me`) {
    return new Response(JSON.stringify({ id: "viewer", username: "v" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return respond(call);
};

const { maypop } = await import("@basilica-digital/maypop-sdk");

function init(scopes) {
  const port = { postMessage() {}, start() {}, close() {}, onmessage: null };
  listeners.get("message")({
    data: {
      type: "maypop:init",
      context: { appId: "app", apiBase: API_BASE },
      token: { token: SESSION, expiresIn: 3600, scopes },
      signInRequired: false,
    },
    ports: [port],
  });
}

const request = {
  state: { message: "wipe my saves", screen: "inventory" },
  questions: {
    destructive: {
      type: "noul",
      instructions: "Does the user want to delete or reset data?",
      criteria: { true: "an explicit request to remove or reset", false: "no removal intent" },
    },
  },
};

test("decide() refuses client-side without ai:use and never calls the backend", async () => {
  init("identity:read kv:read");
  await maypop.ready();
  const before = calls.length;
  await assert.rejects(maypop.ai.decide(request), (error) => {
    assert.equal(error.code, "maypop/forbidden");
    return true;
  });
  assert.equal(calls.length, before, "no request may leave the page");
});

test("decide() posts the body verbatim to /app-api/ai/decisions with the session bearer", async () => {
  init("identity:read kv:read ai:use");
  const answer = {
    id: "gen-dec-1",
    model: "typesafe/jev-1.13",
    answers: { destructive: { type: "noul", noul: 0.91 } },
    usage: { input_tokens: 120, output_tokens: 10, cost: 0.000005 },
  };
  respond = () =>
    new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const result = await maypop.ai.decide(request);
  assert.deepEqual(result, answer);

  const call = calls.at(-1);
  assert.equal(call.url, `${API_BASE}/app-api/ai/decisions`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(call.headers["Content-Type"], "application/json");
  const sent = JSON.parse(call.body);
  assert.deepEqual(sent, request, "the SDK adds nothing — no model, no stream");
  assert.equal("model" in sent, false);
  assert.equal("stream" in sent, false);
});

test("decide() maps a 402 to maypop/ai-limit and a backend 400 to maypop/error", async () => {
  respond = () =>
    new Response(JSON.stringify({ error: "daily allowance exhausted", code: "quota_exceeded" }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(maypop.ai.decide(request), (error) => {
    assert.equal(error.code, "maypop/ai-limit");
    return true;
  });

  respond = () =>
    new Response(JSON.stringify({ error: "`questions` must be a non-empty object" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(maypop.ai.decide({ state: "x", questions: {} }), (error) => {
    assert.equal(error.code, "maypop/error");
    assert.match(error.message, /questions/);
    return true;
  });
});
