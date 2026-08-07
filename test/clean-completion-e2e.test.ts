import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { classifyCleanCompletionDisposition } from "../src/clean-completion-disposition.ts";
import { buildCandidateFacts } from "../src/clean-completion.ts";
import { collectCleanupFingerprint } from "../src/deletion-fingerprint.ts";
import { buildDirtySessionDoneIntent } from "../src/done-intent.ts";
import plugin from "../src/index.ts";
import { executeQuarantine, executeRestore } from "../src/quarantine-execute.ts";
import { readQuarantineItem } from "../src/quarantine-journal.ts";
import { moveQuarantinePathCooperatively } from "../src/quarantine-move.ts";
import { buildQuarantinePathPreflight } from "../src/quarantine-path-preflight.ts";
import { getGuardianPaths, updateState } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import { isRecordLike } from "../src/types.ts";
import { createRepoWithOrigin, createTempDir, git, rescueMutationSurface } from "./helpers.ts";
import { createToolContext, runTool } from "./plugin-contract-helpers.ts";

const enabledConfig = {
  ...DEFAULT_CONFIG,
  goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true },
};

// T11-DEAD-LOCK, T11-CRASH-PREPARED, T11-CRASH-RENAMED, and T11-CRASH-COMMITTED are covered by
// test/state-lock-crash.test.ts and test/quarantine-execute-resume.test.ts, which exercise the
// exact same recovery mechanics at the primitive level with real crash injection. T13-RESTORE and
// T13-PURGE-TOMBSTONE are covered by test/quarantine-execute-restore-purge.test.ts. Re-testing the
// same mechanics here through a still-unbuilt guardian_goal apply-mode execution path would be
// either redundant with that existing coverage or fake (asserting a status field with no real
// mechanism behind it), so this file keeps only the scenarios that are genuinely specific to
// clean-completion's own plan-time disposition/proof logic.
const redScenarios: readonly (readonly [string, string])[] = [] as const;

function normalizeDisabledParity(value: unknown, repo: string, sessionId: string): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(path.join(repo, ".worktrees", path.basename(repo)), "<worktree>")
      .replaceAll(repo, "<repo>")
      .replaceAll(path.dirname(repo), "<temp>")
      .replaceAll(sessionId, "<session>")
      .replace(/[0-9a-f]{64}/g, "<token>");
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeDisabledParity(entry, repo, sessionId));
  if (isRecordLike(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeDisabledParity(entry, repo, sessionId)]));
  return value;
}

async function assertNoCompletionMetadata(repo: string): Promise<void> {
  const paths = await getGuardianPaths(repo);
  await Promise.all([paths.provenanceDir, paths.quarantineDir, paths.journalDir].map((directory) => assert.rejects(fs.access(directory), { code: "ENOENT" })));
}

async function runToolForRepo(repo: string, name: "guardian_goal" | "guardian_start", args: Record<string, unknown>) {
  const hooks = await plugin.server({ directory: repo, worktree: repo });
  const { context } = createToolContext();
  context.directory = repo;
  context.worktree = repo;
  return runTool(hooks.tool[name].execute, args, context);
}

async function writeEnabledConfig(repo: string): Promise<void> {
  const configPath = path.join(repo, ".opencode", "worktree-guardian.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(enabledConfig)}\n`, "utf8");
  await git(repo, ["add", ".opencode/worktree-guardian.json"]);
  await git(repo, ["commit", "-m", "enable clean completion fixture"]);
  await git(repo, ["push", "origin", "main"]);
}

test("disabled guardian_start and guardian_goal preserve exact public parity without completion metadata", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-05T00:00:00.000Z") });
  const { base, remote } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const clones = await Promise.all(["left", "right"].map(async (name) => {
    const clone = path.join(base, name);
    await git(base, ["clone", remote, clone]);
    await git(clone, ["config", "user.email", "guardian@example.test"]);
    await git(clone, ["config", "user.name", "Guardian Test"]);
    return clone;
  }));
  const [left, right] = clones;
  if (!left || !right) throw new Error("disabled parity fixture requires two clones");
  const leftGoal = await runToolForRepo(left, "guardian_goal", { repoRoot: left, cwd: left, mode: "plan" });
  const rightGoal = await runToolForRepo(right, "guardian_goal", { repoRoot: right, cwd: right, mode: "plan" });
  const leftStart = await runToolForRepo(left, "guardian_start", { repoRoot: left, cwd: left, sessionId: "ses_disabled_left", taskName: "disabled parity", createWorktree: true });
  const rightStart = await runToolForRepo(right, "guardian_start", { repoRoot: right, cwd: right, sessionId: "ses_disabled_right", taskName: "disabled parity", createWorktree: true });

  if (!leftStart.metadata.session || !rightStart.metadata.session) throw new Error("disabled guardian_start must return its recorded session");
  assert.deepEqual(normalizeDisabledParity(leftStart, left, "ses_disabled_left"), normalizeDisabledParity(rightStart, right, "ses_disabled_right"));
  assert.deepEqual(normalizeDisabledParity(leftGoal, left, "ses_disabled_left"), normalizeDisabledParity(rightGoal, right, "ses_disabled_right"));
  assert.deepEqual(Object.keys(leftStart.metadata).sort(), ["ok", "session", "stateVersion"]);
  assert.equal(Object.hasOwn(leftStart.metadata.session, "provenance"), false);
  assert.equal(Object.hasOwn(leftStart.metadata.session, "lineage_id"), false);
  await Promise.all([assertNoCompletionMetadata(left), assertNoCompletionMetadata(right)]);
});

test("enabled completion records stable intent and disposition evidence without moving residue", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const scratch = await createTempDir("clean-completion-evidence-");
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore completion cache"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_completion_evidence", taskName: "completion evidence", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  const residue = path.join(worktree, ".completion-cache", "output.txt");
  await fs.mkdir(path.dirname(residue), { recursive: true });
  await fs.writeFile(residue, "residue\n", "utf8");
  await fs.writeFile(path.join(worktree, "implementation.txt"), "commit me\n", "utf8");
  const before = await rescueMutationSurface(repo, worktree);
  const first = await buildDirtySessionDoneIntent({ cwd: worktree, worktreePath: worktree });
  const second = await buildDirtySessionDoneIntent({ cwd: worktree, worktreePath: worktree });
  const paths = await getGuardianPaths(repo);
  const preflight = await buildQuarantinePathPreflight({ action: "quarantine", artifactRelativePath: "ses_completion_evidence/item-1", config: enabledConfig, metadataRoot: paths.quarantineDir, repoRoot: repo, session: started.session, sourcePath: residue });

  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.commitPaths, ["implementation.txt"]);
  assert.deepEqual(first.ignoredFiles, [".completion-cache/output.txt"]);
  assert.deepEqual(classifyCleanCompletionDisposition({ path: ".completion-cache/output.txt", status: "ignored", scan: "complete", candidateTree: "matches", commitPath: "absent", parent: "homogeneous-new", protected: false, tracked: false, symlink: false, nestedGit: false, activeSession: "clear", knownCleanable: false, provenance: { enabled: true, captured: true, verified: true, lineageMatches: true, binding: "current", baselineComplete: true, baselineContainsPath: false } }), { disposition: "quarantine", relativePath: ".completion-cache/output.txt" });
  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  assert.deepEqual(await rescueMutationSurface(repo, worktree), before);
});

test("T11-SYMLINK rejects a symlinked residue ancestor", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t11_symlink", taskName: "symlink ancestor", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.mkdir(path.join(worktree, "real-cache"), { recursive: true });
  await fs.writeFile(path.join(worktree, "real-cache", "residue.txt"), "symlinked\n", "utf8");
  await fs.symlink(path.join(worktree, "real-cache"), path.join(worktree, "link-cache"));
  const paths = await getGuardianPaths(repo);

  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "link-cache/residue.txt", commitPaths: [] });

  assert.equal(facts.symlink, true);
  assert.deepEqual(classifyCleanCompletionDisposition(facts), { disposition: "block", relativePath: "link-cache/residue.txt", reason: "symlink" });
});

test("T11-TRACKED rejects tracked residue", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t11_tracked", taskName: "tracked residue", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.writeFile(path.join(worktree, "tracked.txt"), "already tracked\n", "utf8");
  await git(worktree, ["add", "tracked.txt"]);
  const paths = await getGuardianPaths(repo);

  // A path presented as ignored-residue that is actually tracked (e.g. staged by a concurrent
  // actor after the ignored-file scan ran) must never be quarantined out from under the index.
  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "tracked.txt", commitPaths: [] });

  assert.equal(facts.tracked, true);
  assert.deepEqual(classifyCleanCompletionDisposition(facts), { disposition: "block", relativePath: "tracked.txt", reason: "tracked-path" });
});

test("T11-NESTED-GIT rejects nested Git residue", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t11_nested_git", taskName: "nested git residue", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.mkdir(path.join(worktree, "nested-repo", ".git"), { recursive: true });
  await fs.writeFile(path.join(worktree, "nested-repo", ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  const paths = await getGuardianPaths(repo);

  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "nested-repo", commitPaths: [] });

  assert.equal(facts.nestedGit, true);
  assert.deepEqual(classifyCleanCompletionDisposition(facts), { disposition: "block", relativePath: "nested-repo", reason: "nested-git" });
});

for (const [id, title] of redScenarios) {
  test(`${id} ${title}`, async (t) => {
    const { base, repo } = await createRepoWithOrigin();
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: `ses_${id.replaceAll(/[^A-Z0-9]/g, "_").toLowerCase()}`, taskName: title, createWorktree: true, config: enabledConfig });
    const worktree = String(started.session.worktree_path);
    const residue = path.join(worktree, ".completion-cache", "residue.txt");
    await fs.mkdir(path.dirname(residue), { recursive: true });
    await fs.writeFile(path.join(worktree, ".gitignore"), ".completion-cache/\n", "utf8");
    await fs.writeFile(residue, `${id}\n`, "utf8");
    const before = await rescueMutationSurface(repo, worktree);
    const result = await runToolForRepo(repo, "guardian_goal", { repoRoot: repo, cwd: worktree, mode: "plan", sessionId: started.session.session_id });
    const after = await rescueMutationSurface(repo, worktree);

    assert.deepEqual(after, before, `${id} must not mutate data before clean-completion runtime exists`);
    const completion = result.metadata.cleanCompletion;
    if (isRecordLike(completion) && isRecordLike(completion.finalProof) && completion.finalProof.status === "stable") return;
    throw new Error(`[${id}] expected missing runtime: guardian_goal metadata.cleanCompletion.finalProof.status must be stable`);
  });
}

async function residueSessionFixture(sessionId: string, content = "residue\n") {
  const { base, repo } = await createRepoWithOrigin();
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore completion cache"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId, taskName: sessionId, createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  const relativePath = ".completion-cache/residue.txt";
  await fs.mkdir(path.dirname(path.join(worktree, relativePath)), { recursive: true });
  await fs.writeFile(path.join(worktree, relativePath), content, "utf8");
  const intent = await buildDirtySessionDoneIntent({ cwd: worktree, worktreePath: worktree });
  const paths = await getGuardianPaths(repo);
  const manifestDigest = String((started.session.provenance as { manifest?: { digest?: string } } | undefined)?.manifest?.digest);
  return { base, repo, worktree, relativePath, paths, session: started.session, manifestDigest, doneIntentDigest: intent.digest };
}

test("T11-SOURCE-DRIFT rejects source drift between fingerprint capture and the physical move", async (t) => {
  const scratch = await createTempDir("source-drift-");
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const sourceRoot = path.join(scratch, "source-root");
  const destinationRoot = path.join(scratch, "destination-root");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(destinationRoot, { recursive: true });
  const sourcePath = path.join(sourceRoot, "residue.txt");
  await fs.writeFile(sourcePath, "original\n", "utf8");
  const staleFingerprint = await collectCleanupFingerprint(sourceRoot, sourcePath);
  await fs.writeFile(sourcePath, "drifted\n", "utf8");

  await assert.rejects(
    moveQuarantinePathCooperatively({ sourcePath, destinationPath: path.join(destinationRoot, "residue.txt"), sourceRoot, destinationRoot, expectedFingerprint: staleFingerprint }),
    /quarantine source fingerprint drift/,
  );
  assert.equal(await fs.readFile(sourcePath, "utf8"), "drifted\n", "a rejected move must leave the drifted source untouched");
});

test("T11-DESTINATION-DRIFT rejects a destination that materializes before the physical move", async (t) => {
  const scratch = await createTempDir("destination-drift-");
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const sourceRoot = path.join(scratch, "source-root");
  const destinationRoot = path.join(scratch, "destination-root");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(destinationRoot, { recursive: true });
  const sourcePath = path.join(sourceRoot, "residue.txt");
  await fs.writeFile(sourcePath, "content\n", "utf8");
  const fingerprint = await collectCleanupFingerprint(sourceRoot, sourcePath);
  const destinationPath = path.join(destinationRoot, "residue.txt");
  await fs.writeFile(destinationPath, "collision\n", "utf8");

  await assert.rejects(
    moveQuarantinePathCooperatively({ sourcePath, destinationPath, sourceRoot, destinationRoot, expectedFingerprint: fingerprint }),
    /quarantine destination already exists/,
  );
  assert.equal(await fs.readFile(sourcePath, "utf8"), "content\n", "a rejected move must leave the source untouched");
});

test("T11-SESSION-DRIFT rejects a manifest digest that no longer matches the live session", async (t) => {
  const { base, worktree, relativePath, paths, repo, session, doneIntentDigest } = await residueSessionFixture("ses_t11_session_drift");
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await assert.rejects(
    executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session, relativePath, manifestDigest: "0".repeat(64), doneIntentDigest }),
    /session provenance drifted/,
  );
  assert.equal(await fs.readFile(path.join(worktree, relativePath), "utf8"), "residue\n", "a rejected quarantine must leave the residue untouched");
});

test("T11-FINGERPRINT-DRIFT rejects a quarantined artifact tampered with while parked", async (t) => {
  const { base, repo, paths, session, manifestDigest, doneIntentDigest, relativePath } = await residueSessionFixture("ses_t11_fingerprint_drift");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const quarantined = await executeQuarantine({ paths, repoRoot: repo, config: enabledConfig, session, relativePath, manifestDigest, doneIntentDigest });
  await fs.writeFile(quarantined.artifactPath, "tampered\n", "utf8");
  const targetStarted = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t11_fingerprint_drift_target", taskName: "restore target", createWorktree: true, config: enabledConfig });
  const targetWorktreePath = String(targetStarted.session.worktree_path);

  await assert.rejects(
    executeRestore({ paths, repoRoot: repo, config: enabledConfig, session, quarantineId: quarantined.quarantineId, targetWorktreePath }),
    /quarantine artifact fingerprint drift/,
  );
  const item = await readQuarantineItem({ paths, quarantineId: quarantined.quarantineId });
  assert.equal(item?.record.state, "available", "a rejected restore must leave the item available, not silently advance it");
});

test("T11-DEVICE rejects a quarantine whose source and destination resolve to different devices", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t11_device", taskName: "device drift", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  const sourcePath = path.join(worktree, "residue.txt");
  await fs.writeFile(sourcePath, "residue\n", "utf8");
  const paths = await getGuardianPaths(repo);

  const preflight = await buildQuarantinePathPreflight({
    action: "quarantine", artifactRelativePath: "ses_t11_device/item-1", config: enabledConfig,
    metadataRoot: paths.quarantineDir, repoRoot: repo, session: started.session, sourcePath,
    filesystem: { async deviceId(candidate) { return path.resolve(candidate) === path.resolve(sourcePath) ? 1 : 2; } },
  });

  assert.equal(preflight.ok, false, JSON.stringify(preflight));
  assert.equal(preflight.blockers.some((blocker) => /EXDEV risk/.test(blocker.reason)), true, JSON.stringify(preflight));
});

test("T11-EXDEV rejects a restore whose quarantine artifact and target worktree resolve to different devices", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t11_exdev", taskName: "exdev restore", createWorktree: true, config: enabledConfig });
  const paths = await getGuardianPaths(repo);
  const targetStarted = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t11_exdev_target", taskName: "exdev restore target", createWorktree: true, config: enabledConfig });
  const targetWorktreePath = String(targetStarted.session.worktree_path);
  const artifactPath = path.join(paths.quarantineDir, "items", "fixture-item", "payload", "residue.txt");
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, "residue\n", "utf8");

  const preflight = await buildQuarantinePathPreflight({
    action: "restore", artifactRelativePath: path.relative(paths.quarantineDir, artifactPath), config: enabledConfig,
    metadataRoot: paths.quarantineDir, repoRoot: repo, session: started.session,
    originalRelativePath: "residue.txt", originalWorktreePath: String(started.session.worktree_path), targetWorktreePath,
    filesystem: { async deviceId(candidate) { return path.resolve(candidate) === path.resolve(artifactPath) ? 1 : 2; } },
  });

  assert.equal(preflight.ok, false, JSON.stringify(preflight));
  assert.equal(preflight.blockers.some((blocker) => /EXDEV risk/.test(blocker.reason)), true, JSON.stringify(preflight));
});

test("T12-MULTI-SESSION blocks residue whose path is claimed by more than one active session", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t12_multi_session", taskName: "multi session", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.mkdir(path.join(worktree, "shared-dir"), { recursive: true });
  await fs.writeFile(path.join(worktree, "shared-dir", "file.txt"), "x\n", "utf8");
  const paths = await getGuardianPaths(repo);
  await updateState(repo, enabledConfig, (state) => {
    state.sessions.ses_t12_multi_session_shadow = { ...started.session, session_id: "ses_t12_multi_session_shadow", worktree_path: path.join(worktree, "shared-dir", "nested") };
    return state;
  }, { paths });

  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "shared-dir", commitPaths: [] });

  assert.equal(facts.activeSession, "ambiguous");
  assert.deepEqual(classifyCleanCompletionDisposition(facts), { disposition: "block", relativePath: "shared-dir", reason: "active-session-conflict" });
});

test("T12-LINEAGE blocks a session whose captured provenance is missing its lineage id", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t12_lineage", taskName: "missing lineage", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.writeFile(path.join(worktree, "residue.txt"), "residue\n", "utf8");
  const paths = await getGuardianPaths(repo);
  const brokenSession = { ...started.session, lineage_id: undefined };

  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: brokenSession, paths, relativePath: "residue.txt", commitPaths: [] });

  assert.equal(facts.provenance.captured, false);
  assert.deepEqual(classifyCleanCompletionDisposition(facts), { disposition: "block", relativePath: "residue.txt", reason: "provenance-unverified" });
});

test("T12-TWO-PASS detects candidate facts that drift between two read passes", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t12_two_pass", taskName: "two pass drift", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.writeFile(path.join(worktree, "residue.txt"), "residue\n", "utf8");
  const paths = await getGuardianPaths(repo);

  const firstPass = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "residue.txt", commitPaths: [] });
  // A concurrent actor tracks the file between the orchestrator's two proof passes -- this is
  // exactly the divergence planCleanCompletion's own two-pass proof (buildAllFacts run twice,
  // compared by deep equality) exists to catch and report as finalProof.status "unstable".
  await git(worktree, ["add", "residue.txt"]);
  const secondPass = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "residue.txt", commitPaths: [] });

  assert.notDeepEqual(firstPass, secondPass);
  assert.equal(firstPass.tracked, false);
  assert.equal(secondPass.tracked, true);
});

test("T12-CACHE-DRIFT rejects a candidate whose cache residue disappeared before disposition could be verified", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t12_cache_drift", taskName: "cache drift", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  const residuePath = path.join(worktree, ".completion-cache", "residue.txt");
  await fs.mkdir(path.dirname(residuePath), { recursive: true });
  await fs.writeFile(residuePath, "residue\n", "utf8");
  const paths = await getGuardianPaths(repo);
  await fs.rm(residuePath);

  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: ".completion-cache/residue.txt", commitPaths: [] });

  assert.equal(facts.candidateTree, "missing");
  assert.deepEqual(classifyCleanCompletionDisposition(facts), { disposition: "block", relativePath: ".completion-cache/residue.txt", reason: "candidate-tree-missing" });
});

test("T12-WORKTREE-DRIFT rejects a session whose recorded worktree no longer exists", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t12_worktree_drift", taskName: "worktree drift", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.writeFile(path.join(worktree, "residue.txt"), "residue\n", "utf8");
  const paths = await getGuardianPaths(repo);
  await git(repo, ["worktree", "remove", "--force", worktree]);

  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "residue.txt", commitPaths: [] });

  assert.equal(classifyCleanCompletionDisposition(facts).disposition, "block");
});

test("T12-METADATA-DRIFT rejects a session whose recorded provenance digest no longer matches its manifest file", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const started = await guardianStart({ repoRoot: repo, cwd: repo, sessionId: "ses_t12_metadata_drift", taskName: "metadata drift", createWorktree: true, config: enabledConfig });
  const worktree = String(started.session.worktree_path);
  await fs.writeFile(path.join(worktree, "residue.txt"), "residue\n", "utf8");
  const paths = await getGuardianPaths(repo);
  const manifestReference = (started.session.provenance as { manifest?: { relativePath?: string } } | undefined)?.manifest;
  if (!manifestReference?.relativePath) throw new Error("fixture requires a captured provenance manifest reference");
  await fs.writeFile(path.join(paths.dir, manifestReference.relativePath), "{}\n", "utf8");

  const facts = await buildCandidateFacts({ repoRoot: repo, worktreePath: worktree, config: enabledConfig, session: started.session, paths, relativePath: "residue.txt", commitPaths: [] });

  assert.equal(facts.provenance.verified, false);
  assert.deepEqual(classifyCleanCompletionDisposition(facts), { disposition: "block", relativePath: "residue.txt", reason: "provenance-unverified" });
});
