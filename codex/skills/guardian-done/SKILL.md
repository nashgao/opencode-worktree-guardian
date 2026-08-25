---
name: guardian-done
description: Use when the user says Guardian done, finish the job, complete the implementation, land and clean up, or asks Codex to run the normal Guardian completion workflow.
---

# Guardian Done

Use the Guardian Codex adapter for the implementation-done workflow:

```bash
node <adapter-path> tool guardian_done '{"mode":"plan"}'
```

Inspect the selected lane, dirty files, blockers, and cleanup preview. Only after explicit user confirmation, continue with the same plan options plus `confirm: true`; the adapter may reuse a matching plan token, but a token never authorizes apply and the adapter never creates confirmation. Include an explicit `commitMessage` when Guardian needs to commit dirty work. Add `allowAdminBypass: true` only when the user explicitly approves a branch-protection bypass for that run.

`guardian_done` resolves the target from repo-wide inventory, not from whichever cwd Codex happens to be in. Bare `guardian_done` auto-selects exactly one dirty implementation target. If multiple dirty targets exist, stop on `needs-selection` and rerun the exact `primary=true`, `sessionId=...`, or `branch=...` option shown in the output. Use explicit `primary=true`, `sessionId=...`, or `branch=...` from any cwd when the user already selected the target.

Terminal reattach and stale cleanup are plan-only handoffs. Treat an old terminal id as metadata; only confirmed apply may establish pending-to-active proof. Treat absent empty-lease reconciliation as native evidence, not cleanup authority. For advanced state-only retirement, preserve the branch/proof or report pending proof absent; do no sync, postflight, or deletion, and obtain a fresh plan before another tool acts.

For recovery, use `guardian_done` with `rescue: true` and `mode: "plan"` first. Rescue plan/default is artifact-read-only and token-bound; ignored-untracked residue blocks it. Only matching `mode: "apply"`, `confirm: true` materializes the create-only recovery evidence and cleans only the planned paths. Primary-main unconfirmed apply does not refresh; confirmed apply refreshes and checks drift before mutation. Done-all unconfirmed apply rejects before discovery, fetch, or token reconstruction; confirmed apply refreshes and validates the exact plan.

Never replace `guardian_done` with raw push, merge, branch deletion, worktree deletion, stash mutation, force-push, or protected-branch bypass commands.

After a successful apply, Guardian attaches `postCompletionHygiene`: a bounded read-only inventory of findings, protected roots, reviewable paths, and filesystem-only empty directories. Relay its counts and truncation markers before reporting the task complete. If its status is `scan-failed` or `incomplete`, treat Guardian completion as partial; do not delete anything or declare full completion.
