---
description: Drive the repo toward the configured Guardian desired end state
argument-hint: [mode=plan|apply] [commitMessage=...] [confirm=true]
---

Use the `guardian_goal` native tool for the configured repo goal workflow. Run `mode=plan` first and inspect the desired goal flags, child steps, blockers, and dirty target. Do not stop at the plan when the user invoked this goal workflow: if the plan is safe, continue with `mode=apply`, `confirm: true`, and the same options. The plugin reuses a fresh matching internal plan token, so the user should not have to copy a token in normal command use.

`guardian_goal` reads `.opencode/worktree-guardian.json` `goal` settings. The default goal commits dirty implementation work when a `commitMessage` is explicit, lands/pushes it to the configured base through `guardian_done`, cleans Guardian-owned stale worktrees/branches through existing Guardian gates, and applies safe known-cleanable hygiene cleanup before done so generated cache residue is not committed.

Never force-push, mutate stashes, run raw cleanup, run raw branch deletion, remove worktrees directly, or bypass Guardian preflights. Use lower-level Guardian tools only when the user explicitly asks for a narrower workflow.
