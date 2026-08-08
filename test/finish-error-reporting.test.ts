import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianFinish } from "../src/finish.ts";
import { getGuardianPaths, readState } from "../src/state.ts";
import { guardianStart } from "../src/tools.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

test("guardian_finish reports a final freshness failure as base-unavailable without pushing", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_finish_final_freshness", taskName: "final freshness failure", createWorktree: true, config: DEFAULT_CONFIG });
  const worktree = started.session.worktree_path;
  await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n", "utf8");
  await git(worktree, ["add", "feature.txt"]);
  await git(worktree, ["commit", "-m", "add final freshness fixture"]);

  const tools = path.join(base, "git-wrapper");
  const fetchCount = path.join(tools, "fetch-count");
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = fetch ]; then
    count=0
    if [ -f "$GUARDIAN_FETCH_COUNT" ]; then count=$(cat "$GUARDIAN_FETCH_COUNT"); fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$GUARDIAN_FETCH_COUNT"
    if [ "$count" -gt 1 ]; then exit 97; fi
  fi
done
PATH="$GUARDIAN_REAL_PATH" exec git "$@"
`, "utf8");
  await fs.chmod(path.join(tools, "git"), 0o755);
  const originalPath = process.env.PATH;
  const originalFetchCount = process.env.GUARDIAN_FETCH_COUNT;
  const originalRealPath = process.env.GUARDIAN_REAL_PATH;
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_FETCH_COUNT = fetchCount;
  process.env.GUARDIAN_REAL_PATH = originalPath ?? "";
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalFetchCount === undefined) delete process.env.GUARDIAN_FETCH_COUNT;
    else process.env.GUARDIAN_FETCH_COUNT = originalFetchCount;
    if (originalRealPath === undefined) delete process.env.GUARDIAN_REAL_PATH;
    else process.env.GUARDIAN_REAL_PATH = originalRealPath;
  });

  const result = await guardianFinish({ repoRoot: repo, cwd: worktree, sessionId: started.session.session_id, config: DEFAULT_CONFIG });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "remote base ref could not be fetched or resolved");
  assert.doesNotMatch(String(result.reason), /push failed/);
  assert.equal(typeof result.safetyRef, "string");
  assert.equal(await fs.readFile(fetchCount, "utf8"), "2\n");
  assert.equal((await git(repo, ["ls-remote", "--heads", "origin", started.session.branch])).stdout, "");
  const state = await readState(await getGuardianPaths(repo), { repoRoot: repo, config: DEFAULT_CONFIG });
  const safetyRefs = state.sessions[started.session.session_id]?.safety_refs ?? [];
  assert.equal(safetyRefs.includes(String(result.safetyRef)), true);
});
