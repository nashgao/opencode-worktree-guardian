---
description: Drive the repo toward the configured Guardian desired end state
argument-hint: [mode=plan|apply] [commitMessage=...] [confirm=true]
---

Use the `guardian_goal` native tool for the configured repo goal workflow. Run `mode=plan` first and inspect the desired goal flags, child steps, blockers, dirty target, `complete`, and `hygienePostcondition`. Do not stop at the plan when the user invoked this goal workflow: an actionable strict plan can be `planned-partial`, with `complete: null`. Continue with `mode=apply`, `confirm: true`, and the same options. The plugin reuses a fresh matching internal plan token, so the user should not have to copy a token in normal command use.

`guardian_goal` reads `.opencode/worktree-guardian.json` `goal` settings. The default `hygieneCompletion: "authorized-cleanup"` preserves legacy behavior: it commits dirty implementation work when a `commitMessage` is explicit, lands/pushes it to the configured base through `guardian_done`, cleans Guardian-owned stale worktrees/branches through existing Guardian gates, and applies safe token-bound `known-cleanable` hygiene cleanup before done so generated cache residue is not committed. Residual findings remain visible but do not prevent completion.

Set `goal.hygieneCompletion` to `"no-unprotected-findings"` only when the repo requires strict goal hygiene completion. That mode does not broaden deletion. Both modes auto-delete only token-bound `known-cleanable` findings. Residual `nested-git` and `suspicious` findings require direct explicit review and are never auto-authorized. A dirty nested repository also requires direct `allowDirtyNestedGit`. Configured `protectedPaths` are intentional retention and are excluded; `reviewableCandidates` are inventory, not strict failures. Apply always rescans hygiene. Inspect `complete` and `hygienePostcondition`: `ok: true` means authorized work ran, while strict residuals return `ok: true`, `complete: false`, and `status: "partial"`.

Repository stash inventory is advisory by default and remains visible in the goal's `guardian_done` step; Guardian never mutates it. Only repo config `requireEmptyStashInventory: true` promotes a non-empty inventory to a goal blocker.

Never force-push, mutate stashes, run raw cleanup, run raw branch deletion, remove worktrees directly, or bypass Guardian preflights. Use lower-level Guardian tools only when the user explicitly asks for a narrower workflow.
