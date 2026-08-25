import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianGoal } from "../src/goal.ts";
import { formatGuardianStatusOutput } from "../src/plugin/readable-output-status.ts";
import { guardianStatus } from "../src/recover.ts";
import { guardianReportHtml } from "../src/report.ts";
import { getGuardianPaths, readState, updateState } from "../src/state.ts";
import { guardianStart } from "../src/start.ts";
import type { GuardianConfig } from "../src/types.ts";
import { computeGuardianVerdict } from "../src/verdict.ts";
import { createRepoWithOrigin, git } from "./helpers.ts";

const ENABLED_CONFIG: GuardianConfig = {
  ...DEFAULT_CONFIG,
  goal: { ...DEFAULT_CONFIG.goal, quarantineSessionResidue: true },
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new TypeError(`${name} must be an object`);
}

test("opted-in guardian_goal persists a current clean proof and later state revisions make it stale", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, ".gitignore"), ".completion-cache/\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore clean-completion residue"]);
  await git(repo, ["push", "origin", "main"]);
  const started = await guardianStart({
    repoRoot: repo,
    cwd: repo,
    sessionId: "ses_clean_completion_proof",
    taskName: "clean completion proof",
    createWorktree: true,
    config: ENABLED_CONFIG,
  });
  const worktree = String(started.session.worktree_path);
  const residue = path.join(worktree, ".completion-cache", "residue.txt");
  await fs.mkdir(path.dirname(residue), { recursive: true });
  await fs.writeFile(residue, "recoverable residue\n", "utf8");
  const plan = await guardianGoal({ repoRoot: repo, cwd: worktree, sessionId: "ses_clean_completion_proof", mode: "plan", config: ENABLED_CONFIG });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(typeof plan.confirmToken, "string", JSON.stringify(plan));

  const applied = await guardianGoal({
    repoRoot: repo,
    cwd: worktree,
    sessionId: "ses_clean_completion_proof",
    mode: "apply",
    confirm: true,
    confirmToken: String(plan.confirmToken),
    config: ENABLED_CONFIG,
  });

  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.complete, true, JSON.stringify(applied));
  const appliedProof = record(applied.cleanCompletionProof, "applied.cleanCompletionProof");
  assert.equal(appliedProof.status, "proven");
  assert.equal(appliedProof.quarantineItemCount, 1);
  const paths = await getGuardianPaths(repo);
  const state = await readState(paths, { repoRoot: repo, config: ENABLED_CONFIG });
  const persistedProof = record(state.clean_completion_proof, "state.clean_completion_proof");
  assert.equal(persistedProof.version, 1);
  assert.equal(persistedProof.stateVersion, state.state_version);

  const provenStatus = await guardianStatus({ repoRoot: repo, cwd: repo, config: ENABLED_CONFIG });
  assert.deepEqual(provenStatus.cleanCompletionProof, appliedProof);
  assert.equal(computeGuardianVerdict(provenStatus).tone, "warn");
  assert.equal(provenStatus.hygiene?.summary.protectedInventoryCount, 1);
  const readable = formatGuardianStatusOutput("guardian_status", provenStatus);
  assert.match(readable, /Clean Completion Proof/);
  assert.match(readable, /status: proven/);
  const report = await guardianReportHtml({ repoRoot: repo, cwd: repo, config: ENABLED_CONFIG });
  const html = await fs.readFile(report.reportPath, "utf8");
  assert.match(html, /Clean Completion Proof/);
  assert.match(html, />proven</);

  const manifestRelativePath = started.session.provenance?.manifest?.relativePath;
  if (!manifestRelativePath) throw new Error("proof fixture requires a provenance manifest");
  const manifestPath = path.join(paths.dir, manifestRelativePath);
  const manifestContent = await fs.readFile(manifestPath, "utf8");
  await fs.writeFile(manifestPath, "{}\n", "utf8");
  const tamperedManifestStatus = await guardianStatus({ repoRoot: repo, cwd: repo, config: ENABLED_CONFIG });
  assert.equal(record(tamperedManifestStatus.cleanCompletionProof, "tamperedManifestStatus.cleanCompletionProof").status, "stale");
  assert.doesNotMatch(computeGuardianVerdict(tamperedManifestStatus).headline, /Project clean/);
  await fs.writeFile(manifestPath, manifestContent, "utf8");
  const restoredManifestStatus = await guardianStatus({ repoRoot: repo, cwd: repo, config: ENABLED_CONFIG });
  assert.equal(record(restoredManifestStatus.cleanCompletionProof, "restoredManifestStatus.cleanCompletionProof").status, "proven");

  const recoverableItem = restoredManifestStatus.quarantineItems[0];
  if (!recoverableItem) throw new Error("proof fixture requires a recoverable quarantine item");
  await fs.rm(recoverableItem.artifactPath);
  const missingArtifactStatus = await guardianStatus({ repoRoot: repo, cwd: repo, config: ENABLED_CONFIG });
  assert.equal(record(missingArtifactStatus.cleanCompletionProof, "missingArtifactStatus.cleanCompletionProof").status, "stale");
  assert.doesNotMatch(computeGuardianVerdict(missingArtifactStatus).headline, /Project clean/);

  await updateState(repo, ENABLED_CONFIG, (current) => current, { paths });
  const staleStatus = await guardianStatus({ repoRoot: repo, cwd: repo, config: ENABLED_CONFIG });
  assert.equal(record(staleStatus.cleanCompletionProof, "staleStatus.cleanCompletionProof").status, "stale");
  assert.doesNotMatch(computeGuardianVerdict(staleStatus).headline, /project clean/i);
});

test("status exposes an unsupported persisted proof as invalid without a clean claim", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = await getGuardianPaths(repo);
  await updateState(repo, ENABLED_CONFIG, (state) => {
    state.clean_completion_proof = { version: 2, kind: "clean-completion-proof", status: "complete" };
    return state;
  }, { paths });

  const status = await guardianStatus({ repoRoot: repo, cwd: repo, config: ENABLED_CONFIG });
  const proof = record(status.cleanCompletionProof, "status.cleanCompletionProof");
  assert.equal(proof.status, "invalid");
  assert.doesNotMatch(computeGuardianVerdict(status).headline, /Project clean/);
  const readable = formatGuardianStatusOutput("guardian_status", status);
  assert.match(readable, /Clean Completion Proof/);
  assert.match(readable, /status: invalid/);
});
