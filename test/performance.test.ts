import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand } from "../src/guards.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runGitNullSeparated } from "../src/git.ts";
import { readState, getGuardianPaths } from "../src/state.ts";
import { createRepo, createTempDir, git, seedSession } from "./helpers.ts";

test("long command strings classify quickly and safely", () => {
  const command = `${"printf safe && ".repeat(250)}bash -c "git restore ."`;
  const started = performance.now();
  const result = classifyGuardCommand(command);
  assert.equal(result.blocked, true);
  assert.equal(performance.now() - started < 250, true);
});

test("large guardian state remains readable", async () => {
  const repo = await createRepo();
  for (let index = 0; index < 40; index += 1) {
    await seedSession(repo, {
      session_id: `ses_large_${index}`,
      status: "active",
      branch: `guardian/large-${index}`,
      worktree_path: repo,
      base_ref: "origin/main",
      safety_refs: [],
    });
  }
  const paths = await getGuardianPaths(repo);
  const started = performance.now();
  const state = await readState(paths, { repoRoot: repo, config: DEFAULT_CONFIG });
  assert.equal(Object.keys(state.sessions).length, 40);
  assert.equal(performance.now() - started < 250, true);
});

test("git NUL-separated streaming handles hygiene-sized candidate output without exec maxBuffer", async () => {
  const repo = await createRepo();
  const script = path.join(await createTempDir("guardian-hygiene-stream-"), "emit-large-output.mjs");
  await fs.writeFile(script, `
const suffix = "x".repeat(90);
for (let index = 0; index < 120000; index += 1) {
  process.stdout.write(` + "`entry-${String(index).padStart(6, \"0\")}-${suffix}\\0`" + `);
}
`);

  await git(repo, ["config", "alias.guardian-stream", `!node ${JSON.stringify(script)}`]);
  const entries = await runGitNullSeparated(repo, ["guardian-stream"]);

  assert.equal(entries.length, 120000);
  assert.equal(entries[0], `entry-000000-${"x".repeat(90)}`);
  assert.equal(entries.at(-1), `entry-119999-${"x".repeat(90)}`);
});

test("readiness keeps each command timeout finite and sufficient for verification", async () => {
  const readiness = await readFile(new URL("../scripts/readiness.ts", import.meta.url), "utf8");

  assert.match(readiness, /const commandTimeoutMs = 900000;/);
  assert.match(readiness, /timeout: commandTimeoutMs,/);
  assert.match(readiness, /killSignal: "SIGTERM",/);
});
