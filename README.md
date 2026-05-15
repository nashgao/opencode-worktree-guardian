# opencode-worktree-guardian

OpenCode plugin for safety-first multi-session Git worktree workflows. It creates or attaches sessions to guarded worktrees, blocks raw destructive commands, records repo-local ownership state, creates safety refs before finish operations, and reports recovery candidates without mutating by default.

## Install

Local development uses a project-local shim so OpenCode loads only the plugin server function:

```ts
// .opencode/plugins/worktree-guardian.ts
import Guardian from "/Users/nashgao/Desktop/claude/opencode/plugins/opencode-worktree-guardian/src/index.ts"

export const WorktreeGuardian = Guardian.server
export default Guardian.server
```

Do not mutate global OpenCode config for local smoke tests. Keep local host tests inside disposable repositories.

Published package:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-worktree-guardian"]
}
```

## Configuration

Repo-local config lives at `.opencode/worktree-guardian.json`. The current supported OpenCode/plugin API baseline is OpenCode `1.14.48` with `@opencode-ai/plugin` `^1.14.48`.

```json
{
  "remote": "origin",
  "baseBranch": "main",
  "worktreeRoot": ".worktrees/$REPO",
  "branchPrefix": "guardian/",
  "finishMode": "preserve-only",
  "autoStart": true,
  "autoFinish": false,
  "autoCleanup": false,
  "allowStashIfUnrelated": false,
  "protectedBranches": ["main", "master", "develop", "production"]
}
```

Defaults are conservative. `autoFinish` and `autoCleanup` are disabled unless repo config opts in. Stash mutation is never cleanup.

## Native Tools

- `guardian_start`: create or attach the session to a guardian worktree.
- `guardian_status`: read-only inventory of sessions, worktrees, refs, stashes, dirty files.
- `guardian_finish`: gated finish behavior based on `finishMode`.
- `guardian_preserve`: mark work intentionally preserved and create a preserved ref.
- `guardian_recover`: read-only recovery refs, reflog/unreachable candidates, and suggested commands.

## Safety Model

The plugin blocks raw destructive shell/git commands in `tool.execute.before`, including hard resets, forced cleans, worktree removal/prune, forced branch deletion, stash mutation, force push, destructive checkout/restore/switch forms, shell-wrapped variants, and `rm -rf` against known guardian worktrees.

When `autoStart` is enabled, Guardian can create or attach a session worktree, record repo-local ownership, and keep blocking unsafe commands until the command runs from the owned worktree. This is fail-closed by design: mutating shell/git commands are blocked when the OpenCode host is still in the base repository or any unowned path.

Guardian hooks cannot move the OpenCode host process cwd. If auto-start creates or records a worktree, the host must still execute subsequent mutating commands from that worktree path. Use `guardian_status` to see the owned worktree path and switch the host/session there before retrying writes.

Finish always creates a safety ref before risky operations. `merge-to-base` requires explicit approval, and cleanup only runs when `autoCleanup` or `allowCleanup` is set and ancestry is proven.

## Troubleshooting

- Blocked mutating command: run `guardian_status`; if the session owns a worktree, run the command from that worktree path.
- No owned worktree: run `guardian_start`, then check `guardian_status` before retrying mutating commands.
- Intentional finish or preserve: use `guardian_finish` or `guardian_preserve`; `autoFinish` remains opt-in.
- Dirty worktree: commit or intentionally preserve; Guardian will not stash cleanup.
- Stash exists: inspect with `git stash list` and `git stash show -p`; Guardian will not mutate stashes.
- Orphaned worktree: run `guardian_recover`; suggested recovery commands are read-only until you approve writes.

## Verification

Run:

```bash
npm run verify
npm run audit:deps
npm run test:contract
npm run test:smoke:package
npm run test:smoke:host
npm run test:readiness
```

`test:contract` validates the plugin export, hook, tool, documented local-shim contract, and fail-closed cwd enforcement. `test:smoke:package` packs the artifact, installs it into a clean temporary consumer, and imports it by package name. `test:smoke:host` is deterministic and host-like: it uses a disposable repo and local shim/tool/hook execution without mutating global OpenCode config. `test:readiness` aggregates verification, audit, smoke checks, and `npm pack --dry-run`.

The test suite uses disposable repositories only. Do not run destructive-command smoke tests against live repositories.

## Dependency Audit

Last verified on 2026-05-14:

```text
npm run audit:deps
found 0 vulnerabilities
```


## Manual OpenCode Host Check

The automated host smoke intentionally avoids model-driven OpenCode tool invocation because that path depends on provider auth and can be nondeterministic. When manually validating a real OpenCode host, use a disposable repository only.

Suggested manual checklist:

1. Create a fresh temporary Git repo.
2. Add the local shim from the Install section under `.opencode/plugins/worktree-guardian.ts`.
3. Start OpenCode from that disposable repo.
4. Confirm `guardian_status` is visible and returns repository inventory, including any owned worktree path.
5. From the base repo, ask OpenCode to run a mutating command; confirm Guardian blocks before mutation instead of assuming hooks moved cwd.
6. Switch the host/session to the owned worktree path from `guardian_status`, then retry an allowed write there.
7. Ask OpenCode to run a blocked command such as `git reset --hard`; confirm Guardian still blocks before mutation.

If this manual check disagrees with the deterministic smoke suite, treat the plugin as not release-ready until the discrepancy is understood.
