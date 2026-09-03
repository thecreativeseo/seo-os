#!/usr/bin/env node
/**
 * `next dev`, restarted whenever the Prisma client is regenerated.
 *
 * Why this exists: the Prisma client is held on `globalThis` so it survives hot
 * reloads (src/server/db/prisma.ts). That is the right call for a database
 * connection and the wrong one for the model metadata generated beside it.
 * After `prisma generate` adds a column, the running server keeps validating
 * requests against the old model, and every write that uses the new field
 * fails with "Unknown argument" - while typecheck and the test suite, being
 * fresh processes, pass. The failure looks like a code bug and is not one.
 *
 * So this wrapper runs `next dev` as a child and watches src/generated/prisma.
 * When files there change - `prisma generate`, or `prisma migrate dev`, which
 * runs it - the child is stopped, .next is cleared, and `next dev` is started
 * again in the same terminal. Nothing else about `next dev` changes: arguments
 * pass through (`npm run dev -- -p 3001`), output stays where it was, and
 * Ctrl+C still stops everything.
 *
 * `npm run dev:raw` is the plain command, for when this gets in the way.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, watch } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_BIN = require.resolve("next/dist/bin/next");
const GENERATED = path.join(ROOT, "src", "generated", "prisma");

/** `prisma generate` writes many files; wait for the last one before acting. */
const DEBOUNCE_MS = 1500;

const args = process.argv.slice(2);

let child = null;
let restarting = false;
let shuttingDown = false;
let timer = null;

function log(message) {
  process.stdout.write(`\n[dev] ${message}\n`);
}

function start() {
  const started = spawn(process.execPath, [NEXT_BIN, "dev", ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    // Its own process group on POSIX, so the whole tree can be signalled at
    // once. Windows has no groups; taskkill /T walks the tree instead.
    detached: process.platform !== "win32",
  });

  child = started;

  started.on("exit", (code, signal) => {
    // An old child finishing during a restart, or one we stopped ourselves.
    if (started !== child || restarting || shuttingDown) return;

    // next dev stopped on its own. There is nothing to restart into, so the
    // wrapper mirrors it rather than sitting there looking alive.
    process.exit(code ?? (signal ? 1 : 0));
  });
}

/** Stops the current child and its workers, resolving once it has exited. */
function stop() {
  return new Promise((resolve) => {
    const current = child;

    if (!current || current.exitCode !== null) {
      resolve();
      return;
    }

    current.once("exit", () => resolve());

    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(current.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-current.pid, "SIGTERM");
      } catch {
        current.kill("SIGTERM");
      }
    }
  });
}

async function restart(reason) {
  if (restarting || shuttingDown) return;
  restarting = true;

  log(`${reason}; restarting next dev`);
  await stop();

  // Compiled output can hold references to the old client. A clean start
  // costs a few seconds; a stale one has cost an afternoon.
  rmSync(path.join(ROOT, ".next"), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });

  start();
  restarting = false;
}

function watchGenerated() {
  if (!existsSync(GENERATED)) {
    log(`no generated client at ${GENERATED}; run \`npm run db:generate\` first`);
    return;
  }

  watch(GENERATED, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void restart("Prisma client regenerated"), DEBOUNCE_MS);
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

start();
watchGenerated();
