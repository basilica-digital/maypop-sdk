import assert from "node:assert/strict";
import { test } from "node:test";

const listeners = new Map();
const window = { addEventListener: (type, fn) => listeners.set(type, fn) };
window.parent = window;
Object.assign(globalThis, {
  window,
  document: { addEventListener() {}, documentElement: { dataset: {}, style: {} }, visibilityState: "visible" },
  location: { hash: "" },
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = realSetTimeout(fn, ms, ...args);
  timer.unref?.();
  return timer;
};
let response = {};
let status = 200;
globalThis.fetch = async (url) => new Response(JSON.stringify(
  url.endsWith("/me") ? { id: "viewer", username: "viewer" } : response,
), { status });
const { maypop, isIntegrationUnavailableError } = await import("@basilica-digital/maypop-sdk");
const port = { postMessage() {}, start() {}, close() {} };
listeners.get("message")({
  data: { type: "maypop:init", context: { appId: "app", apiBase: "http://api.test" },
    token: { token: "token", expiresIn: 3600, scopes: "identity:read mcp:use" } },
  ports: [port],
});
await maypop.ready();

// Discovery must preserve outage reasons without exposing connection details.
test("discovers live and unavailable integrations without account data", async () => {
  response = {
    servers: [{ id: "one", name: "owner@example.test", url: "https://example.test/?key=secret", account: "owner@example.test", credential: "secret" }],
    unavailable: [
      { need: { toolkit: "search", name: "Search", logoUrl: null, account: "owner" }, reason: "access_revoked", owner: "owner" },
      { need: { host: "example.test", url: "secret" }, reason: "sign_in_expired" },
    ],
  };
  assert.deepEqual(await maypop.mcp.discover(), {
    available: [{ id: "one" }],
    unavailable: [
      { need: { toolkit: "search", name: "Search", logoUrl: null }, reason: "access_revoked" },
      { need: { host: "example.test" }, reason: "sign_in_expired" },
    ],
  });
  assert.equal((await maypop.mcp.servers())[0].id, "one");
  response = { servers: [] };
  assert.deepEqual(await maypop.mcp.discover(), { available: [], unavailable: [] });
});

// A lost connection must be distinguishable from other service failures.
test("maps unavailable calls and tool listing to a typed error", async () => {
  status = 503;
  response = { error: "Reconnect the integration", code: "integration_unavailable" };
  for (const action of [() => maypop.mcp.call("one", "search"), () => maypop.mcp.tools("one")]) {
    await assert.rejects(action(), (error) => isIntegrationUnavailableError(error));
  }
  response = { error: "Service down", code: "unavailable" };
  await assert.rejects(maypop.mcp.call("one", "search"), (error) => !isIntegrationUnavailableError(error));
  status = 200;
});
