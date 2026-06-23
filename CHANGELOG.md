# Changelog

All notable public-surface changes are tracked here.

## Unreleased

### Added

- `guardian_delete_worktree` now has an explicit `allowRedundantDirtyPaths` opt-in for direct plan/apply deletion of dirty target worktrees only when Guardian proves every dirty path already matches the fetched base tree. The default dirty-target blocker is unchanged. Successful apply creates the normal `safetyRef`, adds a `dirtySnapshotRef`, cleans only proof-approved paths internally, rechecks status, and then uses the existing non-force removal path.
- `guardian_finish` `merge-to-base` can now optionally preserve-then-clean a dirty primary repo worktree instead of dead-ending, gated behind the new `allowBaseWorktreePreserveReset` option (per call or via repo config, default `false`). When enabled, it snapshots the primary worktree's blocking dirt — tracked changes and untracked files, which `git stash create` would drop — into a recoverable `refs/opencode-guardian/<session>/base-worktree-preserved-dirt/...` safety ref, cleans only those paths through Guardian's internal path-scoped reset/clean routine that never touches the Guardian session worktrees under the worktree root, then repositions and fast-forward merges. The default stays fail-closed: without the opt-in, a dirty primary worktree still blocks. New preflight/report fields `baseWorktreePreserveReset` and `baseWorktreePreservedDirtRef` surface the action, and the preserved-dirt ref is recorded in session `safety_refs`.

### Changed

- `guardian_finish` `merge-to-base` now self-heals a clean primary repo worktree that is on the wrong branch. Under `allowMergeToBase: true` it creates safety refs for the primary worktree's original HEAD and the local base branch head, then repositions the primary worktree onto the base branch with `git checkout --no-overwrite-ignore` before the fast-forward merge. This removes the previous dead-end where the agent was blocked from positioning the base worktree but the tool refused to do it itself. A dirty primary worktree still blocks: Guardian never self-heals uncommitted base-worktree work. A base branch checked out in another worktree, a missing local base branch, a non-fast-forward merge, and post-merge push or remote-proof failures all fail closed with safety refs recorded.

### Fixed

- Guardian no longer records a session whose worktree resolves to a different git repository than `repoRoot`. When `context.directory` (which determines the `state.json` location via the git common dir) diverged from the resolved worktree across repositories, session records were written into the wrong repository's state and silently bypassed the `repoRoot`-keyed primary/protected poison guards. `guardian_start` and the `recordSession` writer now refuse cross-repo bindings, and `guardian_gc` detects such mis-homed active records under a new `foreign-repo` reason so they can be pruned.

## 0.1.0 - 2026-06-13

### Added

- Packaged Codex adapter surface under the `./codex` export and `codex/` package files, with adapter smoke coverage.
- Canonical Guardian safety policy in `docs/adr/0001-guardian-safety-policy.md`.
- Public release hygiene documentation in `docs/release-checklist.md` and `docs/publishing.md`.
- Contract and package smoke coverage for public native tools, slash commands, packaged command assets, package exports, package files, and Codex adapter files.

### Changed

- Documented `guardian_hygiene` as the single hygiene scan, plan, and apply surface.
- Clarified README safety guidance to point at the canonical safety policy.

### Removed

- Removed the legacy `guardian_hygiene_cleanup` and `hygiene-cleanup` public command surfaces in favor of `guardian_hygiene`.
