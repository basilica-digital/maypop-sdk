import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the development host keeps what belongs to one machine: the local
 * identity, `dev.json`, MCP fixtures, KV and Drive data, captured
 * notifications, and the lock. It ignores itself in Git, so an app never
 * commits it even when its own `.gitignore` says nothing. `kv-policy.json`
 * stays beside it: the platform reads it from the app's committed source.
 */
export const LOCAL_DIRECTORY = "local";

/** What SDKs before `local/` wrote straight into the data directory. */
const LEGACY_LOCAL_ENTRIES = [
  "config.json",
  "dev.json",
  "kv.json",
  "drive",
  "notifications.json",
  "mcp.json",
];

const LOCAL_GITIGNORE = "# Maypop development data for this machine\n*\n";

/** Create the data directory's self-ignoring `local/` and return its path. */
export async function prepareLocalDirectory(
  dataDirectory: string,
): Promise<string> {
  const localDirectory = join(dataDirectory, LOCAL_DIRECTORY);
  await mkdir(localDirectory, { recursive: true });
  const ignore = join(localDirectory, ".gitignore");
  if (!existsSync(ignore)) await writeFile(ignore, LOCAL_GITIGNORE);
  return localDirectory;
}

/**
 * Move what an older SDK left beside `local/` into it, keeping anything
 * already there. The old `.lock` stays where it is: it may be committed, and
 * it names a PID that means nothing to this machine now.
 */
export async function moveLegacyLocalData(
  dataDirectory: string,
  localDirectory: string,
): Promise<void> {
  for (const name of LEGACY_LOCAL_ENTRIES) {
    const legacy = join(dataDirectory, name);
    const moved = join(localDirectory, name);
    if (!existsSync(legacy) || existsSync(moved)) continue;
    await rename(legacy, moved);
    console.info(
      `[maypop] moved ${legacy} to ${moved}, which stays out of Git.`,
    );
  }
}

interface LockOwner {
  pid: number;
  /** When the process started, as {@link processStart} reads it. */
  start?: string;
  /** Tells this lock from one another server took over after it. */
  token?: string;
}

/**
 * An identity for the process now running as `pid`, which a new process that
 * reuses the PID after a restart does not share, or `undefined` when this
 * system cannot tell.
 */
function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may contain spaces; fields resume after its ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `proc:${boot}:${fields[19]}`;
  } catch {
    // No procfs: ask ps.
  }
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started ? `ps:${started}` : undefined;
  } catch {
    return undefined;
  }
}

function readOwner(path: string): LockOwner | null {
  const contents = readFileSync(path, "utf8").trim();
  try {
    const owner = JSON.parse(contents) as Partial<LockOwner> | number;
    if (typeof owner === "number") return { pid: owner };
    return typeof owner?.pid === "number" ? (owner as LockOwner) : null;
  } catch {
    return null;
  }
}

/** Locks this process holds, by path: a lock naming this PID but not listed
 *  here was left by an earlier process that had the same PID. */
const heldLocks = new Set<string>();

/**
 * Whether a lock no longer means a development server holds the data. It
 * holds only while the very process that wrote it runs: a gone PID, a PID a
 * restart gave to another process, and one naming this process without
 * holding it are stale. So is one with no start time where this system can
 * read them, since nothing then shows its PID was not reused. Where it cannot,
 * a live PID is all there is to go on.
 */
function isStaleLock(owner: LockOwner | null, path: string): boolean {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  if (owner.pid === process.pid) return !heldLocks.has(path);
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return true;
  }
  const current = processStart(owner.pid);
  if (current === undefined) return false;
  return current !== owner.start;
}

const LOCK_ATTEMPTS = 3;

/**
 * Hold the data directory for this development server until the returned
 * function runs, so two servers never write the same data.
 */
export function acquireLocalLock(
  localDirectory: string,
  dataDirectory: string,
): () => void {
  const path = join(localDirectory, ".lock");
  const owner: LockOwner = {
    pid: process.pid,
    start: processStart(process.pid),
    token: randomBytes(12).toString("base64url"),
  };

  const open = (attempt: number): number => {
    try {
      return openSync(path, "wx");
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      let held: LockOwner | null = null;
      try {
        held = readOwner(path);
      } catch (readError) {
        if ((readError as { code?: string }).code !== "ENOENT") throw readError;
      }
      if (attempt < LOCK_ATTEMPTS && isStaleLock(held, path)) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if ((unlinkError as { code?: string }).code !== "ENOENT") {
            throw unlinkError;
          }
        }
        return open(attempt + 1);
      }
      throw new Error(
        `Maypop sandbox data at ${dataDirectory} is already in use by another development server.`,
        { cause: error },
      );
    }
  };

  const descriptor = open(1);
  writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
  heldLocks.add(path);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    heldLocks.delete(path);
    closeSync(descriptor);
    try {
      if (readOwner(path)?.token === owner.token) unlinkSync(path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  };
  // A server that exits without closing (Ctrl-C, or a signal its framework
  // turns into an exit) still clears its lock; one killed outright leaves it
  // for the next server to find stale.
  process.once("exit", release);
  return release;
}
