# OpenCode Worktree Guardian Implementation Plan

## Goal

Build an OpenCode plugin that makes multi-session implementation work safe by default.

The developer experience should stay the same:

```text
Implement the MQTT reconnect recovery.
```

The plugin should handle the worktree lifecycle in the background:

```text
create or attach a session-owned worktree
preserve work before risky transitions
block raw destructive cleanup/reset/stash commands
finish only the current session's worktree
merge, push, verify ancestry, then cleanup
interrupt only when state is unsafe
```

The plugin exists because a previous cleanup workflow removed a feature worktree without preserving the runtime implementation. Skills and instructions are not enough; enforcement must live in plugin hooks and guarded native tools.

## Design Principles

1. **Normal developer flow first** - users should not need to manually run finish/status commands during normal implementation.
2. **Mechanical safety over agent memory** - unsafe actions are blocked even if an agent forgets the policy.
3. **One session owns one worktree** - sessions may inspect other worktrees, but may not finish or remove them.
4. **No global cleanup** - the plugin never cleans all worktrees as a convenience operation.
5. **No stash-as-cleanup** - dirty work blocks finish; the plugin must not create stashes to make cleanup possible.
6. **Safety refs before risk** - create a Git ref before merge, branch deletion, worktree removal, or cleanup.
7. **Cleanup follows proof** - a worktree is removed only after the final commit is proven reachable from `origin/<base>`.
8. **Recovery is read-only by default** - recovery tooling reports refs, paths, and commands; it does not apply or drop work without explicit approval.

## Default Safety Policy

The default mode must protect work before it optimizes for convenience.

Early versions should create or attach a session-owned worktree by default, block destructive commands, and create safety refs so Guardian owns the full lifecycle it starts. Repo config may opt out with `autoStart: false`. The default finish behavior should push the session branch and suggest a PR without silently merging or deleting; direct base-branch merge and cleanup remain explicit opt-ins.

Default config:

```json
{
  "finishMode": "create-pr",
  "autoStart": true,
  "autoFinish": false,
  "autoCleanup": false
}
```

Recommended progression:

| Mode | Behavior |
|---|---|
| `preserve-only` | Create/own worktree, block unsafe commands, create safety refs, never merge/push/cleanup automatically. |
| `push-branch` | Push the session branch and preserve it; no base-branch merge or cleanup. |
| `create-pr` | Push the branch and create or suggest a PR; no local cleanup until PR merge is verified. |
| `merge-to-base` | Merge/push/verify/cleanup current owned worktree after all gates pass. |

`merge-to-base` is opt-in per repo. It should not be the global default.

## Lessons From `opencode-worktree-workflow`

Use the same broad architecture, but not the same cleanup semantics.

| Pattern | Reuse? | Notes |
|---|---:|---|
| Native OpenCode tools | Yes | Expose structured tools for start/status/finish/recover. |
| Co-shipped skill | Yes | Policy and fallback documentation only. |
| Optional slash commands | Yes | Manual debug entry points, not required in normal flow. |
| Plugin hooks | Yes | Required for invisible safety and command interception. |
| CLI fallback | Later | Useful for tests and manual recovery, but not MVP critical. |
| `wt-clean apply <branch>` semantics | No | It can remove selected clean unmerged review work. Guardian must be stricter. |

## User Experience

### Single Session

User says:

```text
Implement feature X.
```

Plugin behavior:

1. Detect the repo and base branch.
2. Create or attach a session-owned worktree by default unless repo config sets `autoStart: false`.
3. Inject session policy into the agent context.
4. Keep shell/tool operations rooted in the owned worktree when ownership is recorded; otherwise allow normal non-destructive commands in the current worktree.
5. Block raw destructive commands.
6. On completion, run the configured finish behavior if safe.
7. In default `create-pr` mode, create a safety ref, push the branch, suggest a PR, and preserve the branch/worktree instead of merging or deleting.
8. If unsafe, preserve work and report the exact blocker.

Expected final success report:

```text
Implemented, committed, pushed, PR suggested, and protected with a safety ref.
Safety ref: refs/opencode-guardian/<session>/<branch>/<timestamp>
```

When `finishMode` is `merge-to-base`, a successful report may instead say:

```text
Implemented, committed, merged to origin/main, verified, and cleaned the session worktree.
Safety ref: refs/opencode-guardian/<session>/<branch>/<timestamp>
```

Expected blocked report:

```text
Blocked: this worktree has uncommitted changes.
Work preserved at: <worktree-path>
Safety ref: <ref-if-created>
Next action: commit the changes or explicitly preserve the worktree.
```

### Two Sessions On The Same Project

User starts two normal sessions:

```text
Session A: Implement MQTT reconnect recovery.
Session B: Implement dashboard polish.
```

Plugin behavior:

| Session | Hidden state | Allowed cleanup |
|---|---|---|
| A | Owns worktree A and branch A | Only A after A's finish gate passes |
| B | Owns worktree B and branch B | Only B after B's finish gate passes |

Session A cannot clean Session B. Session B cannot delete Session A's branch. Both sessions can inspect global status read-only.

If Session A finishes first, the plugin applies Session A's configured finish behavior only to A. Session B remains untouched and later updates against the latest base through its own finish gate.

## Plugin Surfaces

### Native Tools

| Tool | Purpose | Mutates? |
|---|---|---:|
| `guardian_start` | Create or attach the current OpenCode session to a worktree | Yes |
| `guardian_status` | Report repo, sessions, worktrees, safety refs, dirty state | No |
| `guardian_finish` | Apply configured finish mode for the current session's worktree | Yes, gated |
| `guardian_preserve` | Mark the current worktree as intentionally preserved | Yes, metadata/ref only |
| `guardian_recover` | List recovery refs, orphaned worktrees, unreachable candidates | No by default |

### Hooks

| Hook | Purpose |
|---|---|
| `chat.system.transform` | Inject invisible worktree/session policy into agent instructions. |
| `tool.execute.before` | Block dangerous shell/git/worktree commands before execution. |
| `tool.execute.after` | Record Git status, commits, and last safe state after relevant commands. |
| `command.execute.before` | Rewrite optional slash commands into native tool calls. |

### Optional Slash Commands

These are for debugging and manual override, not the normal developer path.

| Command | Purpose |
|---|---|
| `/guardian status` | Read-only multi-worktree inventory. |
| `/guardian finish` | Manually trigger finish gate for current session. |
| `/guardian preserve` | Mark current worktree as intentionally kept. |
| `/guardian recover` | Show safety refs and recovery candidates. |

### Co-shipped Skill

`skills/worktree-guardian/SKILL.md` should explain:

- the invisible workflow
- what agents must not do
- how to respond to blocked states
- fallback behavior if plugin hooks are unavailable
- how to use `guardian_status` for read-only inspection

The skill is not the enforcement layer.

## State Model

Use repo-local state so ownership follows the repository, not a global machine registry.

Proposed path:

```text
.git/opencode-guardian/state.tson
```

Append-only event log path:

```text
.git/opencode-guardian/events.jsonl
```

Lock file path:

```text
.git/opencode-guardian/state.lock
```

All state writes must use an exclusive lock and atomic replace:

1. Acquire `state.lock` with timeout.
2. Read current `state.tson`.
3. Validate schema and expected session version.
4. Write updated state to `state.tson.tmp`.
5. Atomically rename `state.tson.tmp` to `state.tson`.
6. Append lifecycle event to `events.jsonl`.
7. Release lock.

If lock acquisition times out, the plugin must stop and report a concurrent guardian operation instead of guessing.

## Configuration Model

Use a sidecar config file so repo-specific behavior is explicit and reviewable.

Proposed path:

```text
.opencode/worktree-guardian.tson
```

Example config:

```json
{
  "remote": "origin",
  "baseBranch": "main",
  "worktreeRoot": ".worktrees/$REPO",
  "branchPrefix": "guardian/",
  "finishMode": "create-pr",
  "autoStart": true,
  "autoFinish": false,
  "autoCleanup": false,
  "safetyRefRetentionDays": 30,
  "allowStashIfUnrelated": false,
  "protectedBranches": ["main", "master", "develop", "production"]
}
```

Config defaults must be delivery-first and cleanup-conservative:

- `finishMode`: `create-pr`
- `autoStart`: `true`
- `autoCleanup`: `false`
- `allowStashIfUnrelated`: `false`
- protected branches include `main` and `master`

Global config may provide defaults, but repo-local config wins.

Example state:

```json
{
  "schema_version": "1.0.0",
  "repo_root": "/path/to/repo",
  "base_branch": "main",
  "remote": "origin",
  "finish_mode": "create-pr",
  "worktree_root": ".worktrees/$REPO",
  "sessions": {
    "ses_abc": {
      "session_id": "ses_abc",
      "status": "active",
      "branch": "guardian/mqtt-reconnect-20260513-abc",
      "worktree_path": "/path/to/repo/.worktrees/repo/mqtt-reconnect-abc",
      "base_ref": "origin/main",
      "base_commit": "...",
      "head_commit": "...",
      "safety_refs": [
        "refs/opencode-guardian/ses_abc/guardian/mqtt-reconnect-20260513-abc/20260513T120000"
      ],
      "state_version": 3,
      "created_at": "2026-05-13T12:00:00+10:00",
      "updated_at": "2026-05-13T12:20:00+10:00"
    }
  }
}
```

## Branch And Ref Naming

Worktree branch:

```text
guardian/<task-slug>-<short-session>
```

Safety ref:

```text
refs/opencode-guardian/<session-id>/<branch-slug>/<timestamp>
```

Preserved ref:

```text
refs/opencode-guardian/preserved/<session-id>/<branch-slug>/<timestamp>
```

Recovery ref created by explicit user approval:

```text
refs/recovery/opencode-guardian/<description>/<timestamp>
```

## Safety Ref Retention

Safety refs should not be deleted automatically in early versions. They are cheap, explicit, and valuable during incidents.

Retention policy once cleanup is implemented:

| Ref type | Default retention | Deletion rule |
|---|---:|---|
| active session safety refs | indefinite | never while session is active |
| finished session safety refs | 30 days | only after commit is still reachable from `origin/<base>` |
| preserved refs | 30 days | cleanup-eligible after explicit plan/apply and reachability proof |
| recovery refs | indefinite | user-approved deletion only |

Any future prune command must be preview-first and read-only by default.

## Guard Rules

### Blocked Raw Commands

The plugin should block these when run by OpenCode shell/tool calls unless the command is internally issued by `guardian_finish` after the gate passes.

| Pattern | Reason |
|---|---|
| `git reset --hard` | Can erase tracked uncommitted work. |
| `git clean -f`, `git clean -fd`, `git clean -xfd` | Can erase untracked implementation files. |
| `git branch -D` | Can delete unmerged committed work. |
| `git worktree remove` | Can remove another session's workspace. |
| `opencode-worktree-workflow wt-clean apply` | Can remove selected clean unmerged review work. |
| `rm -rf <known-worktree-path>` | Bypasses Git and plugin safety. |
| `git stash push` | Can hide work and make cleanup look safe. |
| `git stash apply`, `git stash pop`, `git stash drop`, `git stash clear` | Can mutate or destroy hidden work. |
| `git push --force`, `git push -f` | Can rewrite shared history. |

### Allowed Read-only Commands

| Pattern | Reason |
|---|---|
| `git status` | Required for diagnostics. |
| `git diff` | Required for review. |
| `git log` | Required for evidence. |
| `git reflog` | Required for recovery. |
| `git branch --list`, `git branch --contains` | Read-only branch inspection. |
| `git worktree list` | Read-only worktree inventory. |
| `git stash list`, `git stash show` | Read-only stash inspection. |
| `git fsck --unreachable`, `git fsck --dangling` | Read-only object recovery inventory. |

`git fsck --lost-found` is not read-only because it writes `.git/lost-found`; require explicit approval.

## Primary Worktree Detection

The plugin must distinguish the session worktree from the primary/base worktree.

Detection algorithm:

1. Run `git rev-parse --show-toplevel` in the current working directory.
2. Run `git worktree list --porcelain` from the repo common dir.
3. Treat the entry whose path owns the common `.git` directory as the primary worktree.
4. Treat the current path as the session worktree when it matches a linked worktree entry.
5. Refuse finish if primary worktree cannot be identified.
6. Refuse finish if the current session is running in the primary worktree and the task is non-trivial.

Primary worktree resolution must be tested with:

- normal primary checkout
- linked worktree under `.worktrees/`
- linked worktree outside repo root
- deleted/stale worktree metadata
- detached linked worktree

## Finish Gate

`guardian_finish` is the only allowed cleanup path. It must respect `finishMode`.

Algorithm:

1. Resolve repo root, primary worktree, base branch, and remote.
2. Confirm current OpenCode session owns the current worktree.
3. Refuse detached HEAD.
4. Capture `BRANCH` and `COMMIT_SHA`.
5. Refuse if `git status --porcelain=v1` is non-empty.
6. Refuse if `git stash list` is non-empty unless user explicitly marks it unrelated after inspection.
7. Create a safety ref pointing to `COMMIT_SHA`.
8. If `finishMode` is `preserve-only`, mark the session `preserved`, report the worktree path/branch/safety ref, and stop.
9. If `finishMode` is `push-branch`, push the owned branch to origin, mark preserved, and stop.
10. If `finishMode` is `create-pr`, push the owned branch, create or suggest a PR, mark preserved, and stop.
11. If `finishMode` is `merge-to-base`, switch primary worktree to base branch.
12. Run `git pull --ff-only origin <base>`.
13. Merge the owned branch into base.
14. Push base to origin.
15. Fetch origin.
16. Verify `git merge-base --is-ancestor "$COMMIT_SHA" "origin/<base>"`.
17. Remove only the owned worktree.
18. Delete only the owned branch, and only after the ancestry check passes.
19. Verify the worktree and branch are gone.
20. Mark the session as `finished` in state.

Failure behavior:

| Failure | Result |
|---|---|
| Dirty worktree | Stop, preserve path, report files. |
| Stash exists | Stop, show stash list/show commands, recommend recovery. |
| Merge conflict | Stop, keep worktree and branch. |
| Push fails | Stop, keep worktree and branch. |
| Ancestry check fails | Stop, keep worktree and branch. |
| Cleanup fails | Stop, keep branch safety ref, report exact failure. |

## Recovery Model

`guardian_recover` should be read-only by default.

It reports:

- active sessions
- orphaned sessions
- current worktrees
- safety refs
- preserved refs
- branches without worktrees
- worktrees without state entries
- stash list and stash stats
- recent reflog entries
- unreachable commits with subjects and touched files

It may offer commands, but should not run recovery writes unless the user explicitly approves.

Example recovery output:

```text
Found safety ref:
refs/opencode-guardian/ses_abc/guardian/mqtt-reconnect/20260513T120000 -> abc123

Suggested recovery command:
git branch recovery/mqtt-reconnect abc123
```

## Implementation Phases

### Phase 0 - Hook API Spike

Goal: prove OpenCode exposes enough runtime context before building the full plugin.

Deliverables:

- minimal plugin entry point
- logging-only hook handlers for `chat.system.transform`, `tool.execute.before`, `tool.execute.after`, and `command.execute.before`
- fixture output showing available session id, message id, working directory, worktree path, tool name, tool input, and command text
- decision record for which hook fields are stable enough to use

Exit criteria:

- stable session id source identified
- current worktree path identified
- shell command text can be inspected before execution
- plugin can distinguish user-visible commands from internal guardian-issued commands
- no repository mutation performed by the spike

### Phase 1 - Guard Mode

Goal: prevent another loss before automation is complete.

Deliverables:

- package scaffold
- plugin entry point
- `tool.execute.before` guard matrix
- `guardian_status` read-only tool
- delivery-first, cleanup-conservative config loading from `.opencode/worktree-guardian.tson`
- tests for blocked commands

Exit criteria:

- raw dangerous cleanup/reset/stash commands are blocked
- read-only status works in a disposable repo
- no automatic merge/cleanup yet
- default behavior is `create-pr` without automatic merge or cleanup

### Phase 2 - Ownership Mode

Goal: track one session to one worktree.

Deliverables:

- repo-local state file
- session id detection
- `guardian_start`
- branch/worktree naming
- safety ref creation utility
- state event log

Exit criteria:

- two simulated sessions get two different worktrees
- each session can only mutate its own state entry
- orphaned state is reported, not cleaned

### Phase 3 - Finish Gate Mode

Goal: safely complete one owned worktree.

Deliverables:

- `guardian_finish`
- primary worktree/base branch resolution
- `finishMode` handling for `preserve-only`, `push-branch`, `create-pr`, and `merge-to-base`
- merge/push/ancestry verification for `merge-to-base`
- cleanup current owned worktree only
- structured result with success/blocker details

Exit criteria:

- clean merged worktree is finished and cleaned
- default `create-pr` finish creates a safety ref, pushes the branch, suggests a PR, and preserves the worktree
- clean unmerged worktree is not cleaned unless finish gate merges and pushes it
- dirty worktree is preserved
- unrelated worktrees survive

### Phase 4 - Recovery Mode

Goal: make recovery routine and safe.

Deliverables:

- `guardian_recover`
- safety ref inventory
- stash inventory
- unreachable commit summary
- recovery command suggestions

Exit criteria:

- recovery reports candidates without mutating the repo
- explicit approval is required to create recovery branches

### Phase 5 - Invisible Mode

Goal: remove manual burden from developer workflow by creating session worktrees automatically while keeping finish and cleanup lifecycle-managed.

Deliverables:

- `chat.system.transform` policy injection
- automatic `guardian_start` for implementation sessions unless repo config sets `autoStart: false`
- automatic configured finish attempt at completion when safe
- blocked-state report format

Exit criteria:

- user can say `implement X` and Guardian creates or attaches a session worktree, then owns the finish/delete lifecycle for that worktree
- plugin routes work into a session worktree only after recorded ownership exists
- plugin applies the configured finish behavior silently only when `autoFinish` is enabled and ownership is recorded
- plugin interrupts only on unsafe states

## Testing Strategy

Use disposable repos only.

### Unit Tests

| Area | Tests |
|---|---|
| command guard parser | blocks destructive variants and allows read-only commands |
| state model | creates, updates, and validates session ownership |
| state locking | serializes concurrent writes and times out safely |
| safety refs | builds valid ref names and creates refs before cleanup |
| finish preflight | dirty/stash/detached/cross-session blockers |
| cleanup parser | treats partial cleanup failure as failure |
| config loading | repo-local config overrides delivery-first, cleanup-conservative defaults |

### Integration Tests

| Scenario | Expected |
|---|---|
| two sessions in one repo | two owned worktrees, no cross-cleanup |
| simultaneous finish attempts | one session holds lock; the other stops without mutation |
| Session A tries to delete Session B branch | blocked |
| dirty worktree finish | blocked, files preserved |
| stash exists | blocked, stash inspection recommended |
| default create-pr finish | creates safety ref, pushes branch, suggests PR, and preserves branch/worktree |
| create-pr finish mode | pushes branch and creates/suggests PR without cleanup |
| clean feature finish | merged, pushed, ancestry verified, cleaned |
| unmerged raw cleanup | blocked |
| plugin restart | state reloads and ownership remains intact |
| orphaned worktree | reported by recover/status, not removed |

### Regression Test For Known Failure

Recreate the old failure mode:

1. Create two worktrees.
2. Put committed work in one clean but unmerged worktree.
3. Ask a simulated agent to clean worktrees.
4. Verify the guardian blocks raw cleanup.
5. Verify no branch/worktree is removed.
6. Verify a safety ref exists for any worktree guardian attempted to finish.

## Package Layout

Start conservative. Avoid over-splitting until the boundaries are real.

```text
opencode-worktree-guardian/
  package.json
  README.md
  IMPLEMENTATION_PLAN.md
  src/
    index.ts
    state.ts
    git.ts
    guards.ts
    finish.ts
  schemas/
    guardian-state.schema.json
    guardian-config.schema.json
  skills/
    worktree-guardian/SKILL.md
  commands/
    guardian-status.md
    guardian-recover.md
    guardian-finish.md
  test/
    unit/
    integration/
```

If implementation starts feeling too split, collapse `git.ts`, `guards.ts`, and `finish.ts` into `src/index.ts` for the MVP.

## Rollout Plan

1. Build and test Phase 1 locally in disposable repos.
2. Enable the guard plugin for this plugin development repo only.
3. Enable for one real low-risk repo.
4. Verify normal implementation sessions are not annoying.
5. Enable for `emqx-postgres-persistence`.
6. Only after several successful sessions, enable global config.

## Installation And Distribution

Local development install:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/Users/nashgao/Desktop/claude/opencode/plugins/opencode-worktree-guardian/src/index.ts"]
}
```

Published install after packaging:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@nashgao/opencode-worktree-guardian"]
}
```

Distribution artifacts:

- npm package containing `src/`, `schemas/`, and `skills/`
- optional release assets for `commands/*.md`
- README with install, config, and recovery guidance
- compatibility notes for supported OpenCode versions

Rollout rule: do not enable globally until the plugin has passed disposable multi-session tests and at least one low-risk real-repo soak test.

## Developer Usage After Rollout

### Normal Implementation

Do what you already do:

```text
Implement <feature>.
```

No manual worktree command required.

### Running Two Sessions

Open two OpenCode sessions in the same project and ask normal tasks:

```text
Session A: Implement MQTT reconnect recovery.
Session B: Implement dashboard compaction polish.
```

Expected behavior:

- each session gets its own worktree
- each session owns only its own branch
- each session can finish only its own work
- neither session can clean the other
- both can inspect global status read-only

### When You See A Block

The plugin should explain the blocker and preserve work.

Examples:

```text
Blocked: dirty worktree. Work preserved at <path>.
```

```text
Blocked: stash exists. Inspect with git stash list and git stash show --stat stash@{0}.
```

```text
Blocked: Session B owns this worktree. Current session may not clean it.
```

Required blocked message fields:

| Field | Purpose |
|---|---|
| blocker | exact reason the action stopped |
| preserved_path | where the work still lives |
| branch | branch containing the work, if any |
| safety_ref | safety ref created before stopping, if any |
| next_action | one or two safe commands or decisions |
| forbidden_action | what the plugin refused to run |

Example:

```text
Blocked: cleanup refused because branch guardian/mqtt-reconnect is not proven on origin/main.
Preserved path: /repo/.worktrees/repo/mqtt-reconnect
Branch: guardian/mqtt-reconnect
Safety ref: refs/opencode-guardian/ses_abc/guardian/mqtt-reconnect/20260513T120000
Next action: push/create PR, or explicitly preserve this worktree.
Forbidden action: git worktree remove /repo/.worktrees/repo/mqtt-reconnect
```

### Manual Debug Commands

Only when needed:

```text
/guardian status
/guardian recover
/guardian preserve
```

`/guardian finish` exists for manual triggering, but normal sessions should not require it.

## Non-goals

- Do not protect against commands run outside OpenCode in a normal terminal.
- Do not clean all worktrees.
- Do not automatically resolve merge conflicts.
- Do not create stashes to hide dirty work.
- Do not delete safety refs automatically in early versions.
- Do not replace Git; only guard the risky lifecycle around agent worktrees.

## Threat And Bypass Model

Guardian protects actions performed through OpenCode plugin/tool execution. It does not protect every possible mutation path on the machine.

| Path | Protected by Guardian? | Notes |
|---|---:|---|
| OpenCode shell/tool call | Yes | `tool.execute.before` can block dangerous commands. |
| Guardian native tool | Yes | Internal gates and ownership checks apply. |
| Normal external terminal | No | User can still run raw Git commands outside OpenCode. |
| IDE file deletion | No | Outside plugin control. |
| OS-level directory removal | No | Outside plugin control. |
| Git GC run outside OpenCode | No | Document freeze/recovery protocol separately. |

Optional later hardening:

- shell wrapper for Git commands in managed repos
- repo-local Git hooks for branch deletion/reset warnings
- periodic safety-ref audit command
- launch-time warning if unmanaged worktrees exist

## Open Questions

1. What exact OpenCode hook context fields are available for stable session id and worktree path?
2. Can OpenCode distinguish internal guardian-issued shell commands from agent-issued shell commands without relying on fragile command text markers?
3. Is `.git/opencode-guardian/` acceptable for all target repos, including bare/linked worktree edge cases?
4. Which PR provider should `create-pr` support first: GitHub CLI only, or provider-agnostic command suggestions?
5. How strict should stash blocking be when a repo already has unrelated old stashes?
6. What is the minimum supported OpenCode version for plugin hooks used by Guardian?

## First Build Slice

The first slice should be deliberately small:

1. `package.json` and plugin entry point.
2. Hook API spike that logs available context without mutating repos.
3. `guardian_status` read-only tool.
4. `tool.execute.before` guard that blocks raw destructive commands.
5. Delivery-first, cleanup-conservative config loader with `finishMode: "create-pr"` default.
6. Disposable repo tests proving the guard blocks the known failure mode.

This gives immediate protection before we add invisible automation.
