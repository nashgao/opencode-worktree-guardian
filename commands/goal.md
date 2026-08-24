---
description: Drive the repo toward the configured Guardian desired end state
argument-hint: [mode=plan|apply] [commitMessage=...] [confirm=true] [allowedRemoteBranches=[...]]
---

Use the `guardian_goal` native tool for the configured repo goal workflow. Run `mode=plan` first and inspect the desired goal flags, child steps, blockers, dirty target, `complete`, and `hygienePostcondition`. Do not stop at the plan when the user invoked this goal workflow: an actionable strict plan can be `planned-partial`, with `complete: null`. Continue with `mode=apply`, `confirm: true`, and the same options. The plugin reuses a fresh matching internal plan token, so the user should not have to copy a token in normal command use.

`allowedRemoteBranches` is an explicit per-call exact-name list on the resolved effective remote. Guardian normalizes and deduplicates the list, binds it into the plan token, excludes listed remote refs from cleanup candidate discovery and strict extra-remote postflight blocking, and still evaluates a same-named local branch for cleanup independently. Pass the same option set on plan and apply. This exception does not persist retention policy, broaden deletion authority, affect unscanned secondary remotes, or allow unlisted remote branches.

For example, invoke `/guardian-goal` with the equivalent native-tool arguments in both phases:

```text
guardian_goal mode=plan allowedRemoteBranches=["__dolt_remote_info__","chore/finalize-standalone-migration"]
guardian_goal mode=apply confirm=true allowedRemoteBranches=["__dolt_remote_info__","chore/finalize-standalone-migration"]
```

`guardian_goal` reads `.opencode/worktree-guardian.json` `goal` settings. The default `hygieneCompletion: "authorized-cleanup"` preserves legacy behavior: it commits dirty implementation work when a `commitMessage` is explicit, lands/pushes it to the configured base through `guardian_done`, cleans Guardian-owned stale worktrees/branches through existing Guardian gates, and applies safe token-bound `known-cleanable` hygiene cleanup before done so generated cache residue is not committed. Residual findings remain visible but do not prevent completion.

Set `goal.hygieneCompletion` to `"no-unprotected-findings"` when residual hygiene findings must prevent completion. Set it to `"no-unprotected-residue"` when unresolved `reviewableCandidates` and incomplete inventory coverage must also prevent completion. Neither mode broadens deletion. Every mode auto-deletes only token-bound `known-cleanable` findings. Residual `nested-git` and `suspicious` findings require direct explicit review and are never auto-authorized. A dirty nested repository also requires direct `allowDirtyNestedGit`. Configured `protectedPaths` are intentional retention and are excluded. Reviewables remain inventory rather than hygiene targets; resolve them by protecting an intentional path, moving retained evidence under a protected path, or planning exact deletion through `guardian_delete_paths`. Apply always rescans hygiene. Inspect `complete` and `hygienePostcondition`: `ok: true` means authorized work ran, while strict residuals return `ok: true`, `complete: false`, and `status: "partial"`.

Repository stash inventory is advisory by default and remains visible in the goal's `guardian_done` step; Guardian never mutates it. Only repo config `requireEmptyStashInventory: true` promotes a non-empty inventory to a goal blocker.

Never force-push, mutate stashes, run raw cleanup, run raw branch deletion, remove worktrees directly, or bypass Guardian preflights. Use lower-level Guardian tools only when the user explicitly asks for a narrower workflow.
