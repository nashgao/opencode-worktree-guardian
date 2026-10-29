---
name: guardian-goal
description: Use when the user asks Codex to drive the repo to the configured Guardian desired end state, such as commit, land, push, clean Guardian worktrees/branches, and safe hygiene cleanup.
---

# Guardian Goal

Use the Guardian Codex adapter for the configured desired-state workflow:

```bash
node <adapter-path> tool guardian_goal '{"mode":"plan","trackGoal":true}'
```

Inspect the configured goal flags, child `guardian_hygiene` and `guardian_done` steps, blockers, selected dirty target, `trackedBaseline`, `complete`, and `hygienePostcondition`. A strict actionable plan can be `planned-partial` with `complete: null`. If legitimate current regular newly added files are listed as reviewable, inspect them and pass their exact repo-relative paths through `intentionalPaths` in both phases. If the user invoked this goal workflow and the plan is safe, continue with the same options plus `confirm: true`; the adapter reuses the matching plan token. Include an explicit `commitMessage` when Guardian needs to commit dirty implementation work.

`trackGoal: true` opts the Codex adapter into one host-session advisory continuation checkpoint under `XDG_STATE_HOME` (or `~/.local/state`). Checkpoint identity includes the repository and exact Guardian-session target or repository-wide scope; legacy version-1 files without scope remain repository-wide. An untracked scoped call cannot replace or clear a broader/different-session goal, and explicitly tracking a conflicting repository or scope warns without replacing it. Use another Codex session or resolve the first goal. The checkpoint does not grant cleanup, deletion, or branch-protection bypass authority. After partial results, re-plan with the original scope/action/proof and continue until `complete: true` for that same scope or an exact human decision or external wait is identified; only matching completion clears the checkpoint. Trusted Codex lifecycle hooks prompt another pass for new incomplete evidence and remind a resumed session of the pending scope; without those hooks, continue from the tool result directly. Do not claim completion from a plan, green checks, or a partial apply.

`allowedRemoteBranches` is an explicit per-call exact-name list on the resolved effective remote. Guardian normalizes and deduplicates the list, binds it into the plan token, excludes listed remote refs from cleanup candidate discovery and strict extra-remote postflight blocking, and still evaluates a same-named local branch for cleanup independently. Pass the same option set on plan and confirmed apply. This exception does not persist retention policy, broaden deletion authority, affect unscanned secondary remotes, or allow unlisted remote branches.

For example:

```bash
node <adapter-path> tool guardian_goal '{"mode":"plan","trackGoal":true,"allowedRemoteBranches":["__dolt_remote_info__","chore/finalize-standalone-migration"]}'
node <adapter-path> tool guardian_goal '{"mode":"apply","confirm":true,"trackGoal":true,"allowedRemoteBranches":["__dolt_remote_info__","chore/finalize-standalone-migration"]}'
```

## Explicit Removed-Session Closure

For an explicitly requested closure after an external owner has removed one recorded session's original worktree and local branch, use the separate `complete-removed-session` action from a surviving worktree of the same repository:

The configured Goal must use the full strict default session preset: `commitDirty`, `landToBase`, `pushBase`, `cleanupWorktrees`, `cleanupBranches`, and `cleanupHygiene` all `true`, `hygieneCompletion: "no-unprotected-residue"`, and `quarantineSessionResidue: false`. The scoped action refuses other presets and conflicting `all`, `primary`, or `branch` target overrides; other presets retain ordinary Goal behavior without weakened requirements.

```bash
node <adapter-path> tool guardian_goal '{"action":"complete-removed-session","mode":"plan","sessionId":"ses_example","expectedRemoteHead":"<full-source-oid>","landedBaseHead":"<full-landed-base-oid>"}'
node <adapter-path> tool guardian_goal '{"action":"complete-removed-session","mode":"apply","confirm":true,"sessionId":"ses_example","expectedRemoteHead":"<full-source-oid>","landedBaseHead":"<full-landed-base-oid>"}'
node <adapter-path> tool guardian_goal '{"action":"complete-removed-session","mode":"plan","sessionId":"ses_example","expectedRemoteHead":"<full-source-oid>","landedBaseHead":"<full-landed-base-oid>"}'
```

Review the plan and obtain explicit confirmation of that exact session/proof. The adapter caches action, session, both proof OIDs and nonancestor opt-in and reuses a matching token only with `mode=apply confirm=true`. The immutable recorded start commit must be ancestral to the source; the source and landed commit trees must match exactly; the landed commit must remain ancestral to the fresh authoritative base. A squash-equivalent source not ancestral to base additionally requires `"allowNonAncestorRemoteDeletion":true` unchanged in all phases. Goal options must also match.

Apply persists `session.external_goal_completion` version 1 as `prepared` before remote mutation, creates its recorded create-only safety ref, exact-head lease-deletes only the recorded owned source branch, then marks only that session deleted with receipt phase `complete`. It preserves `started_head_commit`. Retain a prepared receipt and safety ref on partial failure and re-plan/reconcile only the identical owned proof; pending receipts are protected from stale GC and start repair, while completed records use ordinary terminal retention. Never use bulk GC or start a replacement session to erase recovery evidence.

The final same-proof `mode=plan` call is readback: require `complete: true` and exactly `scope: { kind: "session", sessionId }`. Unknown or changed proof, an advanced remote source, or a recreated path/local branch refuses, even for a previously completed receipt. The caller attests external disposition of former dirty, ignored and untracked material; Guardian cannot verify historical archival or destruction after the filesystem content is gone. This is session completion, not `Project clean`, and it never falls back to primary commit/push/sync, hygiene, bulk GC, or unrelated-session cleanup. Continuation tracking remains advisory and does not authorize or broaden this action.

## Ordinary Desired-State Goal

`guardian_goal` composes existing Guardian gates. `goal.hygieneCompletion` defaults to `no-unprotected-residue`: Guardian applies token-bound `known-cleanable` and filesystem-verified empty-directory cleanup, then compares the selected session's current index with its immutable recorded start commit and blocks before `guardian_done` if a finding, unacknowledged tracked or untracked addition, other reviewable, or incomplete inventory remains. `intentionalPaths` is one-shot, normalized, and token-bound; it protects exact current regular newly added files from the strict gate without persisting policy or authorizing deletion. Baseline tracked files, directories, symlinks, missing paths, globs, and traversal are rejected. Configured `protectedPaths` deny deletion but do not acknowledge tracked additions.

Explicit `authorized-cleanup` and `no-unprotected-findings` remain available. Residual nested Git, suspicious findings, and explicit reviewable deletion require direct review. After apply, require `complete: true`; strict gated delivery returns a blocked completion child and leaves commit/push refs unchanged.

Never replace `guardian_goal` with raw push, merge, branch deletion, worktree deletion, stash mutation, force-push, or cleanup commands.
