---
description: Drive the repo toward the configured Guardian desired end state
argument-hint: [mode=plan|apply] [commitMessage=...] [intentionalPaths=[...]] [confirm=true] [allowedRemoteBranches=[...]]
---

Use the `guardian_goal` native tool for the configured repo goal workflow. Run `mode=plan` first and inspect the desired goal flags, child steps, blockers, dirty target, `complete`, and `hygienePostcondition`. Do not stop at the plan when the user invoked this goal workflow: an actionable strict plan can be `planned-partial`, with `complete: null`. Continue with `mode=apply`, `confirm: true`, and the same options. The plugin reuses a fresh matching internal plan token, so the user should not have to copy a token in normal command use.

`allowedRemoteBranches` is an explicit per-call exact-name list on the resolved effective remote. Guardian normalizes and deduplicates the list, binds it into the plan token, excludes listed remote refs from cleanup candidate discovery and strict extra-remote postflight blocking, and still evaluates a same-named local branch for cleanup independently. Pass the same option set on plan and apply. This exception does not persist retention policy, broaden deletion authority, affect unscanned secondary remotes, or allow unlisted remote branches.

For example, invoke `/guardian-goal` with the equivalent native-tool arguments in both phases:

```text
guardian_goal mode=plan allowedRemoteBranches=["__dolt_remote_info__","chore/finalize-standalone-migration"]
guardian_goal mode=apply confirm=true allowedRemoteBranches=["__dolt_remote_info__","chore/finalize-standalone-migration"]
```

`guardian_goal` reads `.opencode/worktree-guardian.json` `goal` settings. The default `hygieneCompletion: "no-unprotected-residue"` resolves the selected session worktree, applies safe token-bound `known-cleanable` and filesystem-verified empty-directory cleanup, then compares the current index with the immutable recorded session-start commit before `guardian_done`. Any remaining finding, unacknowledged tracked or untracked addition, other reviewable candidate, or incomplete inventory blocks commit and push. Pass exact current regular newly added files through `intentionalPaths` in both plan and apply. The list is normalized, one-shot, token-bound, and never persisted or treated as deletion authority; baseline tracked files, directories, symlinks, missing paths, globs, and traversal are rejected. Configured `protectedPaths` remain deletion boundaries but do not acknowledge tracked additions.

Explicit `"authorized-cleanup"` retains legacy permissive completion and `"no-unprotected-findings"` gates only residual findings. Neither mode broadens deletion. Every completion mode auto-deletes only token-bound `known-cleanable` findings and verified empty directories. Residual `nested-git`, `suspicious`, unacknowledged reviewables, tracked files, and protected content require explicit handling. A dirty nested repository also requires direct `allowDirtyNestedGit`. Apply always rescans hygiene before delivery. When strict residue remains, apply can remove safe junk but returns `ok: false`, `complete: false`, `status: "partial"` with a blocked completion child and unchanged delivery refs.

Repository stash inventory is advisory by default and remains visible in the goal's `guardian_done` step; Guardian never mutates it. Only repo config `requireEmptyStashInventory: true` promotes a non-empty inventory to a goal blocker.

Never force-push, mutate stashes, run raw cleanup, run raw branch deletion, remove worktrees directly, or bypass Guardian preflights. Use lower-level Guardian tools only when the user explicitly asks for a narrower workflow.
