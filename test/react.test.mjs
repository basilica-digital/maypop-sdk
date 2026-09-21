import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  MaypopProvider,
  useMaypopKV,
  useMaypopSession,
} from "maypop-sdk/react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function createClient() {
  const events = new Map();
  let entries = [];
  let kvSubscriber = null;
  let kvUnsubscribeCount = 0;

  const client = {
    app: { id: "app-1" },
    user: { id: "user-1", username: "Ada" },
    mode: "read-write",
    permissions: ["kv:read", "kv:write"],
    signInRequired: false,
    theme: "light",
    ready: async () => {},
    on(event, callback) {
      const callbacks = events.get(event) ?? new Set();
      callbacks.add(callback);
      events.set(event, callbacks);
      return () => callbacks.delete(callback);
    },
    kv: {
      subscribe(_prefix, callback) {
        kvSubscriber = callback;
        callback(entries);
        return () => {
          ++kvUnsubscribeCount;
          kvSubscriber = null;
        };
      },
      async set(key, value) {
        entries = [
          { key, value, author: "user-1", updatedAt: "2026-09-18T00:00:00Z" },
        ];
        kvSubscriber?.(entries);
      },
      async delete() {
        entries = [];
        kvSubscriber?.(entries);
      },
    },
  };

  return {
    client,
    emit(event) {
      for (const callback of events.get(event) ?? []) callback();
    },
    getKvUnsubscribeCount: () => kvUnsubscribeCount,
  };
}

test("React hooks coordinate readiness, lifecycle events, and KV state", async () => {
  const fake = createClient();
  let rendered;

  function Probe() {
    rendered = {
      session: useMaypopSession(),
      count: useMaypopKV("count", 0),
    };
    return null;
  }

  let root;
  await act(async () => {
    root = TestRenderer.create(
      createElement(
        MaypopProvider,
        { client: fake.client },
        createElement(Probe),
      ),
    );
  });

  assert.equal(rendered.session.status, "ready");
  assert.equal(rendered.session.user.username, "Ada");
  assert.equal(rendered.session.theme, "light");
  assert.equal(rendered.count.status, "ready");
  assert.equal(rendered.count.value, 0);

  await act(async () => rendered.count.setValue(3));
  assert.equal(rendered.count.value, 3);
  assert.equal(rendered.count.isMutating, false);

  fake.client.mode = "read-only";
  await act(async () => fake.emit("modechange"));
  assert.equal(rendered.session.mode, "read-only");

  await act(async () => rendered.count.deleteValue());
  assert.equal(rendered.count.value, 0);

  await act(async () => root.unmount());
  assert.equal(fake.getKvUnsubscribeCount(), 1);
});
