# Worktree Guardian

Use the native guardian tools for worktree inspection and completion. The skill is guidance only; the plugin hooks enforce safety.

## Rules

- Do not run raw cleanup, reset, stash mutation, force-push, worktree removal, or `rm -rf` against worktrees.
- Use `guardian_status` for read-only inventory.
- Use `guardian_finish` for gated completion.
- Use `guardian_preserve` when work should intentionally remain available.
- Use `guardian_recover` for safety refs, orphaned sessions, stash inventory, reflog, and recovery suggestions.
- If the plugin blocks a command, report the blocker, preserved path, branch, safety refs, and suggested guardian tool.

## Defaults

- `finishMode`: `preserve-only`
- `autoFinish`: disabled unless repo config opts in
- `autoCleanup`: disabled unless repo config opts in
- stash mutation is never cleanup

## Recovery posture

Recovery is read-only by default. Creating recovery branches requires explicit user approval.
