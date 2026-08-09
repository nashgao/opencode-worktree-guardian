---
name: guardian-goal
description: Use when the user asks Codex to drive the repo to the configured Guardian desired end state, such as commit, land, push, clean Guardian worktrees/branches, and safe hygiene cleanup.
---

# Guardian Goal

Use the Guardian Codex adapter for the configured desired-state workflow:

```bash
node <adapter-path> tool guardian_goal '{"mode":"plan"}'
```

Inspect the configured goal flags, child `guardian_hygiene` and `guardian_done` steps, blockers, selected dirty target, `complete`, and `hygienePostcondition`. A strict actionable plan can be `planned-partial` with `complete: null`. If the user invoked this goal workflow and the plan is safe, continue with the same plan options plus `confirm: true`; the adapter reuses the matching plan token. Include an explicit `commitMessage` when Guardian needs to commit dirty implementation work.

`guardian_goal` composes existing Guardian gates. `goal.hygieneCompletion` defaults to `authorized-cleanup`, preserving legacy completion even when residual findings remain visible. `no-unprotected-findings` requires a post-apply rescan with no residual unprotected findings. This is a completion postcondition, not broader deletion authority: both modes auto-delete only token-bound `known-cleanable` findings. Residual `nested-git` and `suspicious` findings require direct explicit review and are never auto-authorized; dirty nested Git additionally requires direct `allowDirtyNestedGit`. Configured `protectedPaths` are intentional retention and excluded. `reviewableCandidates` are inventory, not strict failures. After apply, inspect `complete` and `hygienePostcondition`, not just `ok`; strict residuals return `ok: true`, `complete: false`, and `status: "partial"`. Guardian does not force unmerged abandonment, raw cleanup, stash mutation, or protected-branch bypasses.

Never replace `guardian_goal` with raw push, merge, branch deletion, worktree deletion, stash mutation, force-push, or cleanup commands.
