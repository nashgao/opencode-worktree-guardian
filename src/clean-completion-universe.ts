import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { guardianMetadataSnapshot } from "./clean-completion-metadata.ts";
import { expandWorktreeRoot } from "./config.ts";
import { realPathOrResolved } from "./done-shared.ts";
import { isSameOrInside } from "./filesystem-boundaries.ts";
import { getGuardianPaths } from "./guardian-paths.ts";
import { isAncestor, listRefs, listWorktrees, runGitNullSeparated } from "./git.ts";
import { protectedDirReason } from "./hygiene-scan.ts";
import { listIncompleteQuarantineOperations, listQuarantineItems } from "./quarantine-journal.ts";
import { protectedPathsFromConfig } from "./protected-paths.ts";
import { readState } from "./state.ts";
import type { GuardianConfig, GuardianPaths, GuardianStateRecord } from "./types.ts";
import { isRecordLike } from "./types.ts";

async function guardianWorktreeRootSnapshot(repoRoot: string, config: GuardianConfig): Promise<{ readonly entries: readonly string[]; readonly reason?: string }> {
  const root = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return { entries: [] };
    return { entries: [], reason: `Guardian worktree root inventory failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const registered = new Set((await Promise.all((await listWorktrees(repoRoot)).map(async (worktree) => path.resolve(await realPathOrResolved(worktree.path))))));
  const visible: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    const canonical = path.resolve(await realPathOrResolved(candidate));
    if (!registered.has(canonical)) return { entries: [], reason: `unregistered Guardian worktree root entry: ${entry.name}` };
    visible.push(entry.name);
  }
  return { entries: visible.sort() };
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function registeredWorktreeSnapshot(repoRoot: string, config: GuardianConfig): Promise<{ readonly worktrees: readonly { readonly path: string; readonly status: readonly string[]; readonly tracked: readonly string[]; readonly ignored: readonly string[] }[]; readonly reason?: string }> {
  try {
    const worktrees = await listWorktrees(repoRoot);
    const registeredRoots = await Promise.all(worktrees.map(async (worktree) => path.resolve(await realPathOrResolved(worktree.path))));
    const guardianRoot = path.resolve(repoRoot, expandWorktreeRoot(config.worktreeRoot, repoRoot));
    const protectedPaths = protectedPathsFromConfig(config);
    const inventories = await Promise.all(worktrees.map(async (worktree, index) => {
      const visible = (entry: string) => {
        if (protectedDirReason(entry, protectedPaths)) return false;
        const candidate = path.resolve(worktree.path, entry);
        return !isSameOrInside(candidate, guardianRoot)
          && !registeredRoots.some((root, rootIndex) => rootIndex !== index && isSameOrInside(candidate, root));
      };
      const [status, tracked, untracked, ignored] = await Promise.all([
        runGitNullSeparated(worktree.path, ["status", "--porcelain=v1", "--untracked-files=no", "-z"]),
        runGitNullSeparated(worktree.path, ["ls-files", "-z", "--stage"]),
        runGitNullSeparated(worktree.path, ["ls-files", "-z", "--others", "--exclude-standard"]),
        runGitNullSeparated(worktree.path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]),
      ]);
      return {
        path: registeredRoots[index] ?? path.resolve(worktree.path),
        status: [...status, ...untracked.filter(visible).map((entry) => `?? ${entry}`)],
        tracked,
        ignored: ignored.filter(visible),
      };
    }));
    return { worktrees: inventories };
  } catch (error) {
    return { worktrees: [], reason: `registered worktree inventory failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function recordedGuardianRefs(state: GuardianStateRecord): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const session of Object.values(state.sessions)) {
    for (const ref of session.safety_refs ?? []) refs.add(ref);
    const reservationRef = session.dirty_commit_safety_ref_reservation?.safety_ref;
    if (reservationRef) refs.add(reservationRef);
  }
  if (Array.isArray(state.remote_branch_cleanup_reservations)) {
    for (const reservation of state.remote_branch_cleanup_reservations) {
      if (isRecordLike(reservation) && typeof reservation.safety_ref === "string") refs.add(reservation.safety_ref);
    }
  }
  return refs;
}

async function isRemoteBranchCleanupSafetyRef(repoRoot: string, entry: { readonly name: string; readonly commit: string }): Promise<boolean> {
  const prefix = "refs/opencode-guardian/remote-branch-cleanup/";
  if (!entry.name.startsWith(prefix)) return false;
  const segments = entry.name.slice(prefix.length).split("/").filter(Boolean);
  const recordedHead = segments.at(-1);
  if (segments.length < 3 || !recordedHead || !/^[0-9a-f]{40,64}$/.test(recordedHead) || !/^[0-9a-f]{40,64}$/.test(entry.commit)) return false;
  try {
    return await isAncestor(repoRoot, entry.commit, recordedHead);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function isBranchOnlyCleanupSafetyRef(entry: { readonly name: string; readonly commit: string }): boolean {
  const prefixes = ["refs/opencode-guardian/merged-local-branch/", "refs/opencode-guardian/orphan-guardian-branch/"];
  const prefix = prefixes.find((candidate) => entry.name.startsWith(candidate));
  if (!prefix) return false;
  const segments = entry.name.slice(prefix.length).split("/").filter(Boolean);
  const legacyRecordedHead = segments.at(-1);
  if (segments.length >= 2 && typeof legacyRecordedHead === "string" && /^[0-9a-f]{40,64}$/.test(legacyRecordedHead) && entry.commit === legacyRecordedHead) return true;
  const commitMarkerIndex = segments.lastIndexOf("commit");
  const recordedHead = commitMarkerIndex >= 0 ? segments[commitMarkerIndex + 1] : undefined;
  return commitMarkerIndex > 0 && commitMarkerIndex === segments.length - 3 && typeof recordedHead === "string" && /^[0-9a-f]{40,64}$/.test(recordedHead) && entry.commit === recordedHead;
}

async function guardianRefSnapshot(repoRoot: string, allowedRefs: ReadonlySet<string>): Promise<{ readonly refs: readonly string[]; readonly reason?: string }> {
  try {
    const refs = await listRefs(repoRoot, "refs/opencode-guardian");
    const activeLock = refs.find((entry) => entry.name === "refs/opencode-guardian/locks/state");
    if (activeLock) return { refs: [], reason: "Guardian state lock is active during clean-completion proof" };
    for (const entry of refs) {
      if (!allowedRefs.has(entry.name) && !await isRemoteBranchCleanupSafetyRef(repoRoot, entry) && !isBranchOnlyCleanupSafetyRef(entry)) return { refs: [], reason: `unknown Guardian safety ref: ${entry.name}` };
    }
    return { refs: refs.map((entry) => `${entry.name}:${entry.commit}`).sort() };
  } catch (error) {
    return { refs: [], reason: `Guardian safety ref inventory failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type CleanCompletionUniverseProof = {
  readonly status: "stable" | "unstable";
  readonly reason?: string;
  readonly inventoryDigest?: string;
  readonly stateVersion?: number;
  readonly worktreeCount?: number;
  readonly quarantineItemCount?: number;
  readonly incompleteOperationCount: number;
};

async function cleanCompletionUniverseSnapshot(repoRoot: string, config: GuardianConfig, paths: GuardianPaths) {
  try {
    const state = await readState(paths, { repoRoot, config });
    const [quarantineItems, incompleteOperations] = await Promise.all([
      listQuarantineItems({ paths }),
      listIncompleteQuarantineOperations({ paths }),
    ]);
    const [worktreeRoot, metadata, registeredWorktrees, refs] = await Promise.all([
      guardianWorktreeRootSnapshot(repoRoot, config),
      guardianMetadataSnapshot({ paths, state, quarantineItems }),
      registeredWorktreeSnapshot(repoRoot, config),
      guardianRefSnapshot(repoRoot, recordedGuardianRefs(state)),
    ]);
    const reason = worktreeRoot.reason ?? metadata.reason ?? registeredWorktrees.reason ?? refs.reason
      ?? (incompleteOperations.length > 0 ? `${incompleteOperations.length} incomplete quarantine operation(s) require recovery before completion is stable` : undefined);
    return {
      worktreeRoot,
      metadata,
      registeredWorktrees,
      refs,
      state: JSON.stringify(state),
      stateVersion: state.state_version ?? 0,
      quarantineItems: quarantineItems.map((item) => `${item.relativePath}:${item.digest}`).sort(),
      quarantineItemCount: quarantineItems.length,
      incompleteOperationCount: incompleteOperations.length,
      ...(reason ? { reason } : {}),
    };
  } catch (error) {
    return {
      worktreeRoot: { entries: [] },
      metadata: { entries: [] },
      registeredWorktrees: { worktrees: [] },
      refs: { refs: [] },
      state: "",
      stateVersion: 0,
      quarantineItems: [],
      quarantineItemCount: 0,
      incompleteOperationCount: 0,
      reason: `clean-completion inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function proveCleanCompletionUniverse(input: {
  readonly repoRoot: string;
  readonly config: GuardianConfig;
  readonly requireCleanWorktrees?: boolean;
}): Promise<CleanCompletionUniverseProof> {
  const paths = await getGuardianPaths(input.repoRoot);
  const first = await cleanCompletionUniverseSnapshot(input.repoRoot, input.config, paths);
  const second = await cleanCompletionUniverseSnapshot(input.repoRoot, input.config, paths);
  const incompleteOperationCount = Math.max(first.incompleteOperationCount, second.incompleteOperationCount);
  const reason = first.reason ?? second.reason;
  if (reason) return { status: "unstable", reason, incompleteOperationCount };
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    return { status: "unstable", reason: "Guardian worktree or metadata inventory drifted between proof passes", incompleteOperationCount };
  }
  if (input.requireCleanWorktrees) {
    const dirty = second.registeredWorktrees.worktrees.find((worktree) => worktree.status.length > 0 || worktree.ignored.length > 0);
    if (dirty) return { status: "unstable", reason: `registered worktree is not clean: ${dirty.path}`, incompleteOperationCount };
  }
  return {
    status: "stable",
    inventoryDigest: crypto.createHash("sha256").update(JSON.stringify(second)).digest("hex"),
    stateVersion: second.stateVersion,
    worktreeCount: second.registeredWorktrees.worktrees.length,
    quarantineItemCount: second.quarantineItemCount,
    incompleteOperationCount,
  };
}
