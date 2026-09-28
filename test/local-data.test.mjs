import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { maypop } from "@basilica-digital/maypop-sdk/vite";

async function start(root) {
  const lifecycle = new EventEmitter();
  await maypop().configureServer({
    config: { root, logger: { info() {} } },
    httpServer: lifecycle,
    middlewares: { use() {} },
  });
  return () => lifecycle.emit("close");
}

async function app(t) {
  const root = await mkdtemp(join(tmpdir(), "maypop-local-data-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("keeps machine data in a local/ that Git ignores, beside the app's committed files", async (t) => {
  const root = await app(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, ".maypop"), { recursive: true });
  await writeFile(join(root, ".maypop", "kv-policy.json"), "{}\n");
  const close = await start(root);
  t.after(close);

  await stat(join(root, ".maypop", "local", "config.json"));
  await stat(join(root, ".maypop", "local", ".lock"));
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(untracked, ".maypop/kv-policy.json");
});

test("moves an older SDK's machine files into local/, leaving its lock alone", async (t) => {
  const root = await app(t);
  const data = join(root, ".maypop");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "kv.json"), JSON.stringify({ schemaVersion: 1, shared: {}, members: {} }));
  await writeFile(join(data, "config.json"), JSON.stringify({ appId: "app", viewerId: "viewer" }));
  // An old lock naming a live process, as a committed one does after a restart.
  await writeFile(join(data, ".lock"), String(process.ppid) + "\n");

  const close = await start(root);
  t.after(close);
  const identity = JSON.parse(await readFile(join(data, "local", "config.json"), "utf8"));
  assert.equal(identity.appId, "app");
  await assert.rejects(stat(join(data, "kv.json")), { code: "ENOENT" });
  await stat(join(data, "local", "kv.json"));
  assert.equal(await readFile(join(data, ".lock"), "utf8"), String(process.ppid) + "\n");
});

test("takes over a lock whose PID now belongs to another process", async (t) => {
  const root = await app(t);
  const local = join(root, ".maypop", "local");
  await mkdir(local, { recursive: true });
  const lock = join(local, ".lock");
  for (const owner of [
    { pid: process.ppid, start: "ps:before the restart", token: "old" },
    { pid: process.pid, token: "this process" },
  ]) {
    await writeFile(lock, JSON.stringify(owner));
    const close = await start(root);
    close();
    await assert.rejects(stat(lock), { code: "ENOENT" });
  }
});

test("refuses data another running development server holds", async (t) => {
  const root = await app(t);
  const close = await start(root);
  t.after(close);
  const lock = join(root, ".maypop", "local", ".lock");
  const held = JSON.parse(await readFile(lock, "utf8"));
  await writeFile(lock, JSON.stringify({ ...held, pid: process.ppid, start: undefined }));
  await assert.rejects(start(root), /already in use by another development server/);
});
