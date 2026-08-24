import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { projectRoot } from "./package-smoke-helpers.ts";

const testTempParent = path.join(os.homedir(), ".cache", "opencode", "worktree-guardian-tests");
const SignalEnvironmentSchema = z.object({ childPid: z.number(), compile: z.string(), root: z.string() });

async function readJsonLine(stream: NodeJS.ReadableStream): Promise<z.infer<typeof SignalEnvironmentSchema>> {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const newline = buffered.indexOf("\n");
    if (newline < 0) continue;
    return SignalEnvironmentSchema.parse(JSON.parse(buffered.slice(0, newline)));
  }
  throw new Error("wrapper closed before emitting a JSON line");
}

function processIsGone(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function createTestBase(prefix: string): Promise<string> {
  await fs.mkdir(testTempParent, { recursive: true });
  return fs.mkdtemp(path.join(testTempParent, prefix));
}

test("coverage wrapper forwards SIGTERM to its direct child and cleans before re-signaling", async (t) => {
  const base = await createTestBase("coverage-signal-");
  const project = path.join(base, "project");
  let wrapper: ChildProcess | undefined;
  t.after(async () => {
    if (wrapper?.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGTERM");
    await fs.rm(base, { recursive: true, force: true });
  });
  await fs.mkdir(project);

  const wrapperScript = path.join(projectRoot, "scripts", "with-safe-node-temp.mjs");
  const childScript = "const line = JSON.stringify({ root: process.env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN, compile: process.env.NODE_COMPILE_CACHE, childPid: process.pid }); process.stdout.write(line.slice(0, 8)); setTimeout(() => process.stdout.write(line.slice(8) + '\\n'), 10); setTimeout(() => process.exit(0), 2000);";
  wrapper = spawn(process.execPath, [wrapperScript, "--", process.execPath, "--experimental-test-coverage", "-e", childScript], {
    cwd: project,
    env: {
      ...process.env,
      TMPDIR: base,
      TMP: base,
      TEMP: base,
      NODE_V8_COVERAGE: "",
      NODE_COMPILE_CACHE: "",
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN: "",
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_CAPABILITY: "",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.ok(wrapper.stdout);
  const environment = await readJsonLine(wrapper.stdout);
  const closed = once(wrapper, "close", { signal: AbortSignal.timeout(5_000) });
  assert.equal(wrapper.kill("SIGTERM"), true);
  const [exitCode, signal] = await closed;

  assert.equal(exitCode, null);
  assert.equal(signal, "SIGTERM");
  assert.equal(processIsGone(environment.childPid), true);
  assert.deepEqual(await Promise.all([exists(environment.root), exists(environment.compile)]), [false, false]);
});
