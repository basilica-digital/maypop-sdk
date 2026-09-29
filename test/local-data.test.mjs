import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
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

/** A development server in its own process; `then` runs once it holds the data. */
async function startElsewhere(root, then) {
  const code = [
    'import { EventEmitter } from "node:events";',
    'import { maypop } from "@basilica-digital/maypop-sdk/vite";',
    "await maypop().configureServer({",
    "  config: { root: " + JSON.stringify(root) + ", logger: { info() {} } },",
    "  httpServer: new EventEmitter(),",
    "  middlewares: { use() {} },",
    "});",
    'process.stdout.write("ready\\n");',
    then,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [chunk] = await once(child.stdout, "data");
  assert.equal(chunk.toString().trim(), "ready");
  return child;
}

async function app(t) {
  const root = await mkdtemp(join(tmpdir(), "maypop-local-data-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const lockPath = (root) => join(root, ".maypop", "local", ".lock");

/** Whether this system tells when a process started (procfs, or a usable ps). */
function readsProcessStart() {
  try {
    execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return existsSync("/proc/self/stat");
  }
}

test("keeps machine data in a local/ that Git ignores, beside the committed KV policy", async (t) => {
  const root = await app(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, ".maypop"), { recursive: true });
  await writeFile(join(root, ".maypop", "kv-policy.json"), "{}\n");
  const close = await start(root);
  t.after(close);

  await stat(join(root, ".maypop", "local", "config.json"));
  await stat(lockPath(root));
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
  await writeFile(join(data, "mcp.json"), JSON.stringify({ schemaVersion: 1, servers: [] }));
  // An old lock naming a live process, as a committed one does after a restart.
  await writeFile(join(data, ".lock"), String(process.ppid) + "\n");

  const close = await start(root);
  t.after(close);
  const identity = JSON.parse(await readFile(join(data, "local", "config.json"), "utf8"));
  assert.equal(identity.appId, "app");
  for (const moved of ["kv.json", "mcp.json"]) {
    await assert.rejects(stat(join(data, moved)), { code: "ENOENT" });
    await stat(join(data, "local", moved));
  }
  assert.equal(await readFile(join(data, ".lock"), "utf8"), String(process.ppid) + "\n");
});

test("takes over a lock unless the process that wrote it still runs", async (t) => {
  if (!readsProcessStart()) return t.skip("this system cannot tell when a process started");
  const root = await app(t);
  const local = join(root, ".maypop", "local");
  await mkdir(local, { recursive: true });
  for (const owner of [
    // A PID a restart gave to another live process.
    { pid: process.ppid, start: "ps:before the restart", token: "reused" },
    // A live PID with no start time to prove it was not reused.
    { pid: process.ppid, token: "unproven" },
    // This process, which does not hold the lock.
    { pid: process.pid, start: "any", token: "this process" },
  ]) {
    await writeFile(lockPath(root), JSON.stringify(owner));
    const close = await start(root);
    close();
    await assert.rejects(stat(lockPath(root)), { code: "ENOENT" });
  }
});

test("refuses data a development server in another process holds", async (t) => {
  const root = await app(t);
  const other = await startElsewhere(root, "setInterval(() => {}, 1000);");
  t.after(() => other.kill("SIGKILL"));
  await assert.rejects(start(root), /already in use by another development server/);
});

test("a server that exits clears its lock, and one killed outright is taken over", async (t) => {
  const root = await app(t);
  const exited = await startElsewhere(root, "process.exit(0);");
  await once(exited, "exit");
  await assert.rejects(stat(lockPath(root)), { code: "ENOENT" });

  const killed = await startElsewhere(root, "setInterval(() => {}, 1000);");
  killed.kill("SIGKILL");
  await once(killed, "exit");
  await stat(lockPath(root));
  const close = await start(root);
  t.after(close);
});
