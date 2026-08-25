---
name: guardian-goal
description: Use when the user asks Codex to drive the repo to the configured Guardian desired end state, such as commit, land, push, clean Guardian worktrees/branches, and safe hygiene cleanup.
---

# Guardian Goal

Use the Guardian Codex adapter for the configured desired-state workflow:

```bash
node <adapter-path> tool guardian_goal '{"mode":"plan"}'
```

Inspect the configured goal flags, child `guardian_hygiene` and `guardian_done` steps, blockers, selected dirty target, `complete`, and `hygienePostcondition`. A strict actionable plan can be `planned-partial` with `complete: null`. If legitimate current regular untracked files are listed as reviewable, inspect them and pass their exact repo-relative paths through `intentionalPaths` in both phases. If the user invoked this goal workflow and the plan is safe, continue with the same options plus `confirm: true`; the adapter reuses the matching plan token. Include an explicit `commitMessage` when Guardian needs to commit dirty implementation work.

`allowedRemoteBranches` is an explicit per-call exact-name list on the resolved effective remote. Guardian normalizes and deduplicates the list, binds it into the plan token, excludes listed remote refs from cleanup candidate discovery and strict extra-remote postflight blocking, and still evaluates a same-named local branch for cleanup independently. Pass the same option set on plan and confirmed apply. This exception does not persist retention policy, broaden deletion authority, affect unscanned secondary remotes, or allow unlisted remote branches.

For example:

```bash
node <adapter-path> tool guardian_goal '{"mode":"plan","allowedRemoteBranches":["__dolt_remote_info__","chore/finalize-standalone-migration"]}'
node <adapter-path> tool guardian_goal '{"mode":"apply","confirm":true,"allowedRemoteBranches":["__dolt_remote_info__","chore/finalize-standalone-migration"]}'
```

`guardian_goal` composes existing Guardian gates. `goal.hygieneCompletion` defaults to `no-unprotected-residue`: Guardian applies token-bound `known-cleanable` and filesystem-verified empty-directory cleanup, rescans the selected session worktree, and blocks before `guardian_done` if a finding, unacknowledged reviewable, or incomplete inventory remains. `intentionalPaths` is one-shot, normalized, and token-bound; it protects exact current regular untracked files from hygiene without persisting policy or authorizing deletion. Directories, symlinks, tracked files, missing paths, globs, and traversal are rejected.

Explicit `authorized-cleanup` and `no-unprotected-findings` remain available. Residual nested Git, suspicious findings, and explicit reviewable deletion require direct review. After apply, require `complete: true`; strict gated delivery returns a blocked completion child and leaves commit/push refs unchanged.

Never replace `guardian_goal` with raw push, merge, branch deletion, worktree deletion, stash mutation, force-push, or cleanup commands.
