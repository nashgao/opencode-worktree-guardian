---
description: Drive the repo toward the configured Guardian desired end state
argument-hint: [mode=plan|apply] [commitMessage=...] [intentionalPaths=[...]] [confirm=true] [allowedRemoteBranches=[...]] [action=complete-removed-session sessionId=... expectedRemoteHead=... landedBaseHead=...] [allowNonAncestorRemoteDeletion=true]
---

Use the `guardian_goal` native tool for the configured repo goal workflow. Run `mode=plan` first and inspect the desired goal flags, child steps, blockers, dirty target, `complete`, and `hygienePostcondition`. Do not stop at the plan when the user invoked this goal workflow: an actionable strict plan can be `planned-partial`, with `complete: null`. Continue with `mode=apply`, `confirm: true`, and the same options. The plugin reuses a fresh matching internal plan token, so the user should not have to copy a token in normal command use.

`allowedRemoteBranches` is an explicit per-call exact-name list on the resolved effective remote. Guardian normalizes and deduplicates the list, binds it into the plan token, excludes listed remote refs from cleanup candidate discovery and strict extra-remote postflight blocking, and still evaluates a same-named local branch for cleanup independently. Pass the same option set on plan and apply. This exception does not persist retention policy, broaden deletion authority, affect unscanned secondary remotes, or allow unlisted remote branches.

For example, invoke `/guardian-goal` with the equivalent native-tool arguments in both phases:

```text
guardian_goal mode=plan allowedRemoteBranches=["__dolt_remote_info__","chore/finalize-standalone-migration"]
guardian_goal mode=apply confirm=true allowedRemoteBranches=["__dolt_remote_info__","chore/finalize-standalone-migration"]
```

For an explicitly requested closure of one recorded session whose original worktree and local branch were already removed externally, use `action=complete-removed-session` with the exact recorded `sessionId`, full published source `expectedRemoteHead` OID, and full `landedBaseHead` OID:

This action requires the configured full strict default session Goal preset: `commitDirty`, `landToBase`, `pushBase`, `cleanupWorktrees`, `cleanupBranches`, and `cleanupHygiene` all `true`, `hygieneCompletion: "no-unprotected-residue"`, and `quarantineSessionResidue: false`. It refuses other presets and conflicting `all`, `primary`, or `branch` targets; other presets continue to use their ordinary Goal workflow without relaxed requirements.

```text
guardian_goal action=complete-removed-session mode=plan sessionId=ses_example expectedRemoteHead=<full-source-oid> landedBaseHead=<full-landed-base-oid>
guardian_goal action=complete-removed-session mode=apply confirm=true sessionId=ses_example expectedRemoteHead=<full-source-oid> landedBaseHead=<full-landed-base-oid>
guardian_goal action=complete-removed-session mode=plan sessionId=ses_example expectedRemoteHead=<full-source-oid> landedBaseHead=<full-landed-base-oid>
```

Inspect the session scope and proof, then obtain explicit confirmation for that exact closure before apply. Repeat identical action/session/proof/Goal options in all phases; low-level calls also need the returned `confirmToken`. The immutable start commit must be ancestral to the source, the source and landed trees must be equal, and the landed commit must remain ancestral to the fresh authoritative base. A squash-equivalent nonancestor source additionally needs `allowNonAncestorRemoteDeletion=true` in every phase, without weakening the tree proof.

Apply records `session.external_goal_completion` version 1 as `prepared`, creates its recorded create-only safety ref, and exact-head lease-deletes only the owned recorded remote source before marking only that session deleted and the receipt `complete`. Never reset `started_head_commit`. On partial failure, retain the prepared receipt and safety ref and re-plan/retry only that same owned proof; pending receipts are protected from stale GC and start repair. Unknown or changed proof, an advanced source, or a recreated path/local branch refuses, even after completion. The final same-proof plan is readback and must report `complete: true` with exactly `scope: { kind: "session", sessionId }`.

The request attests external disposition of any former dirty, ignored or untracked files; Guardian proves current absence and committed-tree relationships, not how previously removed filesystem content was archived or destroyed. Session closure is not `Project clean`. Do not omit the action and fall back to primary publishing, hygiene, bulk GC or unrelated-session cleanup; this action performs none of those operations. See the [canonical policy](../docs/adr/0001-guardian-safety-policy.md#guardian_goal-removed-session-closure-policy).

## Ordinary Desired-State Goal

`guardian_goal` reads `.opencode/worktree-guardian.json` `goal` settings. The default `hygieneCompletion: "no-unprotected-residue"` resolves the selected session worktree, applies safe token-bound `known-cleanable` and filesystem-verified empty-directory cleanup, then compares the current index with the immutable recorded session-start commit before `guardian_done`. Any remaining finding, unacknowledged tracked or untracked addition, other reviewable candidate, or incomplete inventory blocks commit and push. Pass exact current regular newly added files through `intentionalPaths` in both plan and apply. The list is normalized, one-shot, token-bound, and never persisted or treated as deletion authority; baseline tracked files, directories, symlinks, missing paths, globs, and traversal are rejected. Configured `protectedPaths` remain deletion boundaries but do not acknowledge tracked additions.

Explicit `"authorized-cleanup"` retains legacy permissive completion and `"no-unprotected-findings"` gates only residual findings. Neither mode broadens deletion. Every completion mode auto-deletes only token-bound `known-cleanable` findings and verified empty directories. Residual `nested-git`, `suspicious`, unacknowledged reviewables, tracked files, and protected content require explicit handling. A dirty nested repository also requires direct `allowDirtyNestedGit`. Apply always rescans hygiene before delivery. When strict residue remains, apply can remove safe junk but returns `ok: false`, `complete: false`, `status: "partial"` with a blocked completion child and unchanged delivery refs.

Repository stash inventory is advisory by default and remains visible in the goal's `guardian_done` step; Guardian never mutates it. Only repo config `requireEmptyStashInventory: true` promotes a non-empty inventory to a goal blocker.

Never force-push, mutate stashes, run raw cleanup, run raw branch deletion, remove worktrees directly, or bypass Guardian preflights. Use lower-level Guardian tools only when the user explicitly asks for a narrower workflow.
