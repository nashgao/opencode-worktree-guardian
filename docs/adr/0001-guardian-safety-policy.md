# ADR 0001: Threat Model and Concurrency Boundary

## Status

Accepted.

## Context

Guardian protects multi-session Git worktree workflows by routing normal work into owned worktrees and by requiring native, token-gated tools for destructive or lifecycle operations. This policy records the canonical safety contract for public Guardian surfaces.

This document is the authority for block, allow, route, plan/apply, confirmation, and deletion posture. README, skills, slash commands, packaged markdown commands, and Codex adapter docs are discoverability surfaces and must summarize or point here instead of defining a conflicting policy.

## Threat Model And Concurrency Boundary

Guardian mediates cooperative native and routed writers. Apply assumes target quiescence from writers that are not using those Guardian-managed paths while it moves from the final validation to the native operation.

Audit and strict command interception classify or block work performed through their supported host surfaces; neither is OS-wide exclusion. Guardian therefore does not provide arbitrary same-UID atomicity: uncooperative or malicious same-UID writers are outside this guarantee. In particular, a write after an apply operation's final observed-drift check is outside the cooperative boundary.

## Policy Authority And Public Surfaces

The public native tools are:

- `guardian_start`
- `guardian_init`
- `guardian_status`
- `guardian_project_status`
- `guardian_recover`
- `guardian_report_html`
- `guardian_done`
- `guardian_goal`
- `guardian_finish`
- `guardian_finish_workflow`
- `guardian_preserve`
- `guardian_unblock_finish`
- `guardian_delete_worktree`
- `guardian_delete_paths`
- `guardian_hygiene`
- `guardian_gc`

OpenCode slash commands and packaged `commands/*.md` wrappers are prompt surfaces only. They must instruct the agent to use the matching native tool and must not authorize raw shell cleanup, raw worktree removal, stash mutation, raw branch deletion, force-push, protected-branch bypasses, or deletion outside Guardian preflights.

The Codex adapter is also a first-class public surface. It must invoke the same Guardian tool policies through the adapter CLI and hooks, not through raw destructive Git or shell commands.

## OpenCode And Codex Command Interception

OpenCode and Codex enforce the same interception contract. OpenCode classifies commands in `tool.execute.before`; Codex classifies them through `codex/hooks/guardian-hook.ts`. `commandInterceptionMode` controls the consequence in both hosts:

- `audit` is the default. OpenCode logs the classification with `auditOnly: true`; the Codex pre-tool hook exits successfully with no blocking response. Both allow the command to proceed.
- `strict` preserves fail-closed interception. Guardian throws before execution for the same command classes.

Invalid interception configuration fails closed. Runtime aliases, configured executable paths, alternate executable paths, shell transport, standard-input payloads, and dynamically constructed command or ref destinations are classified before execution rather than treated as safe because their spelling differs from a direct command.

Classified command classes include:

- hard reset and forced clean,
- raw worktree removal or prune,
- raw `git worktree add` outside Guardian-owned roots,
- raw branch deletion,
- stash mutation,
- recovery-ref mutation, including `refs/opencode-guardian` roots and descendants,
- force push,
- opaque, dynamic, or runtime transport destinations that may target protected or recovery refs,
- destructive checkout, restore, or switch forms,
- shell-wrapped variants and context-mode code payloads,
- `rm -rf` against known Guardian worktrees.

The parser recognizes GNU `env -iS` command wrappers. GNU `env -P` is unsafe and is classified rather than treated as an allowlisted wrapper. Guardian does not claim to resolve arbitrary configured remote refmaps.

Agents must use Guardian-native tools for lifecycle and deletion work. A prompt, slash command, skill, or adapter invocation cannot override these blocks.

Native Guardian deletion, hygiene, finish, and done tools keep their token, confirmation, ownership, protected-path, and safety-ref gates regardless of command interception mode. Audit mode changes only raw command interception consequences.

## Read-Only And Normal Safe Git Allowances

Read-only inventory and recovery surfaces are allowed through `guardian_status`, `guardian_project_status`, `guardian_recover`, and `guardian_hygiene` without `mode`. Their output is evidence only and does not authorize cleanup.

`guardian_project_status` reads roadmap, milestone review, plan, and ULW loop artifacts from explicit project roots or the current repo root. It does not establish project ownership, worktree ownership, or lifecycle authority. Its default call must not mutate Git, Guardian state, scanned repositories, or project artifacts. Its explicit `writeReport: true` report path is limited to `.git/opencode-guardian/project-report.html`.

When a session owns a valid Guardian worktree, normal safe mutating commands such as `git add` and `git commit` may proceed through Guardian routing. Without recorded ownership, normal non-destructive commands may run in the current worktree. Destructive cleanup, reset, stash, force-push, worktree-removal, and protected-branch bypass guards are audited by default and block only when `commandInterceptionMode` is `strict`.

Guardian-spawned Git and GitHub CLI processes must not inherit caller-controlled `GIT_*` behavior. The process boundary strips inherited Git environment variables, permits only Guardian-supplied temporary-index and author/committer identity values, disables interactive prompts and `core.fsmonitor`, and applies a bounded child-process deadline. Repository, global, and system configuration remains effective, so configured commit signing is normalized through Git's boolean parser and hook policy is still inspected; enabled policy or an unreadable effective-policy result blocks plumbing commits rather than being bypassed.

## `guardian_start` Session And Worktree Ownership

Guardian owns a session worktree after the chat-system hook creates or attaches one, unless repo config disables automatic ownership with `autoStart: false`. `autoStartMode: "eager"` is the default and creates ownership during chat-system setup. `autoStartMode: "lazy"` leaves read-only sessions on the current worktree and creates ownership before the first repo-local direct file mutation or command that is not proven read-only; after that creation, the normal recorded-worktree routing and finish rules apply. `guardian_start` is the explicit path to create or attach ownership before the hook has run.

Ownership is proven by Guardian state or by token-bound target resolution, not by branch prefix alone. Explicit descriptive branch names are allowed when state or a token-bound target proves the exact branch/worktree binding.

If older or corrupted state records an active session on the primary repo worktree or a protected branch, `guardian_start` with `createWorktree: true` is the repair path. It creates a fresh Guardian worktree, overwrites the poisoned binding, and leaves the primary worktree untouched. Without allowed worktree creation, Guardian must block rather than return the bad binding.

## Session Routing And Mismatch Fail-Closed Rules

Guardian hooks do not move the OpenCode host process cwd. Before safe shell or Git tools run, Guardian rewrites the execution directory to the recorded worktree and then reapplies destructive-command guards.

Direct file mutation tool paths under the primary repo are rewritten into the recorded worktree when the session owns one. When the recorded worktree cannot be validated, the failure is audited by default and blocks only when `commandInterceptionMode` is `strict`. Missing, unresolvable, unrecorded, stale, primary-worktree, or protected-branch session bindings remain fail-closed for native Guardian tool preflights.

## Protected Branch Bypass Prevention

Protected branches include the configured `protectedBranches`, with defaults including `main`, `master`, `develop`, and `production`.

When config context is available, Guardian classifies manual bypasses such as pushing `HEAD` or `guardian/*` directly to a protected branch, and merging `guardian/*` while already on a protected branch. These classifications are audited by default and block only when `commandInterceptionMode` is `strict`. Normal Guardian work must finish through `guardian_done` or the lower-level finish tools. A command wrapper must not ask the agent to bypass this policy with raw push, merge, switch, or branch commands.

## Base Freshness And Git Host Protection

Guardian has a mandatory local freshness invariant for every transition that relies on a base-branch proof. Immediately before its own handoff, Guardian fetches and resolves the authoritative effective base for that operation, then revalidates the feature branch against it. The effective authority is normally the configured remote/base, but cleanup-only flows may use a trusted tracked upstream that supplies the base ref. Guardian blocks stale, divergent, or unverifiable state at that final observation. A locally observed base, a cached remote-tracking ref, or a prior plan is not enough to authorize the transition.

`guardian_status` is different: it is a read-only inventory surface that reports base distance from locally cached Git refs and does not explicitly refresh refs for that report. Its drift report is useful evidence, but it is not current remote-base proof and cannot authorize finish, land, or cleanup.

Guardian's local revalidation is within the cooperative boundary and cannot atomically prevent a base advance after its final observation. Git-host branch protection is therefore the necessary concurrent-writer backstop, complementary to rather than a replacement for Guardian's local gate. Administrators should independently configure the repository's host controls:

- On GitHub, protect the base branch and require status checks configured as strict or up to date before merge, or use a merge queue. See [Require status checks before merging](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging), [Update branch protection](https://docs.github.com/rest/branches/branch-protection#update-branch-protection), and [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).
- On GitLab, choose fast-forward or semi-linear merge behavior and use merged results pipelines or merge trains as appropriate. GitLab has no identical strict-status-check switch. See [Merge methods](https://docs.gitlab.com/user/project/merge_requests/methods/), [Merged results pipelines](https://docs.gitlab.com/ci/pipelines/merged_results_pipelines/), and [Enforce merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/#enforce-merge-trains).

Guardian does not enable or alter these host settings generically. The correct action depends on the provider, repository identity, available credentials and permissions, subscription tier, and the need to preserve existing repository rules. Host configuration remains an administrator decision. An explicit `allowAdminBypass: true` can waive Guardian's host-enforcement requirement for that run.

## Protected Repo Paths

Repo-local config may declare `protectedPaths`, a hard-deny list of repo-relative file or directory roots. When the field is omitted, Guardian uses its default local agent-state roots. When it is present, the configured list replaces those template defaults so the repo has one explicit cleanup authority. `.beads` remains a mandatory hard-deny path and cannot be removed through repo configuration.

Protected paths are not hygiene findings, do not receive cleanup suggestions, and are fatal blockers for `guardian_delete_paths` even when tracked, recursive, or ignored deletion would otherwise be allowed. This policy applies to repo-path deletion surfaces, not to worktree or branch cleanup; worktree deletion remains governed by its own dirty-state, ancestry, ownership, and safety-ref gates.

## `guardian_done` Implementation-Done Policy

`guardian_done` is the user-facing implementation-done workflow. Run `mode: "plan"` first and inspect the selected lane, preflight facts, dirty files, blockers, and confirmation posture.

Target resolution is repo-inventory-first. `guardian_done` must inspect dirty implementation targets across the protected primary/base worktree and active Guardian sessions before selecting a lane. Bare `guardian_done` may auto-select only when exactly one dirty implementation target exists. If more than one dirty target exists, it must return `needs-selection` with exact `guardian_done primary=true`, `guardian_done sessionId=...`, or `guardian_done branch=...` follow-up commands and must not commit, merge, publish, or clean anything.

Explicit `primary=true`, `sessionId=...`, or `branch=...` is target selection authority from any cwd and wins over unrelated dirty files in the caller cwd. A user must not have to move into a specific worktree to finish unambiguous Guardian-owned work.

The supported lanes are:

- `done-all`: when there are no dirty implementation targets and active Guardian feature sessions exist, bare `guardian_done` enumerates every active feature session, lands or already-landed-cleans each clean finishable session after confirmation, skips dirty/protected sessions with exact next actions, fast-forwards the local base worktree only when safe, and applies token-bound safe redundant cleanup candidates before finishing sessions. Guardian-owned stale local branch-only leftovers may be recoverably abandoned in this cleanup sweep only when terminal Guardian state or a matching safety ref proves ownership and Guardian lists the unmerged commit evidence. Candidate-level cleanup blockers such as dirty worktrees, protected branches, detached worktrees, unowned branches, or otherwise unproven stale Guardian worktrees/branches do not stop safe session finishing or safe cleanup; they remain reported under `remaining`, and the lane returns `partial` until the repo has no remaining blockers. `all=true` remains accepted but is not required for this normal clean-primary path.
- `session-finish`: for an active recorded session selected by cwd, by sole dirty target, by `sessionId`, or by `branch`, confirmed apply commits dirty session work only with an explicit `commitMessage`, pushes the branch, creates or reuses the PR, merges it, proves the session commit is reachable from `remote/baseBranch`, then removes the stale Guardian worktree and local branch. It may fast-forward the local base when safe and may apply token-bound safe redundant cleanup candidates while reporting dirty, protected, unmerged, detached, base-sync, or otherwise unproven leftovers. Admin bypass is never automatic and requires explicit `allowAdminBypass: true`. If the current directory is an existing Guardian-root worktree without an active recorded session, `guardian_done` may first attach a fresh internal recovery session id to that worktree and then finish it through the low-level `guardian_finish` path.
- `cleanup-only`: routes clean primary-base cleanup through `guardian_finish_workflow` when there are no active feature sessions to finish. `guardian_done` uses this lane to clean merged redundant worktrees/branches and to recoverably abandon Guardian-owned stale local branch-only leftovers with terminal-state or safety-ref ownership proof.
- `primary-main-publish`: handles dirty protected primary `baseBranch` work selected by sole dirty target or explicit `primary=true` only with an explicit `commitMessage`, explicit confirmation, and the matching internally token-bound dirty snapshot.

The current worktree path, checked-out branch, protected-branch policy, dirty-file gates, and finish preflight are the recovery proof for an existing Guardian-root worktree. The old session id is not required for recovery and must not be the only way to finish a leftover Guardian worktree.

Active-session apply must not clean up its own session until the PR merge has completed and the session commit is proven reachable from the freshly fetched remote base ref. Primary-main apply creates a pre-commit safety ref, commits only token-bound dirty paths, pushes normally to the configured remote/base branch, fetches, proves remote reachability, and applies only token-bound safe redundant cleanup while reporting any remaining blockers. The primary-main lane must not force-push, mutate stashes, delete unrelated or unproven branches, merge PRs, or treat old primary/protected session records as ownership.

Dirty active-session planning constructs and token-binds an exact temporary-index candidate tree without mutating the real index. Tracked modifications, deletions, and renames stage through index-update semantics even when their paths are ignored; genuinely new files use normal add semantics, and ignored-untracked files are never force-added. Apply commits only the approved tree, CAS-updates the expected local head, and pushes the approved OID through a full refspec with an exact remote-head lease. Guardian fails closed before candidate construction when clean filters, executable commit hooks, or commit signing policy would otherwise run or be bypassed.

The token-bound remote base OID is a transition ratchet, not merely an ancestry checkpoint. Immediately before PR merge, the remote base must still equal the planned OID. After merge, Guardian accepts only an unchanged base where the approved head is already reachable, a fast-forward exactly to the approved head, or an exact two-parent merge whose parents are the planned base and approved head in that order. An arbitrary descendant, octopus merge, reversed-parent merge, unrelated advance, or unchanged base without the approved head blocks cleanup and preserves the session for recovery.

Done-all must reuse each planned child token and authorize it against the current accepted base cursor. It fetches the configured remote directly rather than deriving a remote name from `baseRef`, so valid remote names containing `/` retain their exact identity. The cursor advances only after the child succeeds and the same exact transition classifier accepts its observed remote base. A failed child may be isolated so later children continue only when the remote base is proven unchanged; any failed child that moved the base, or whose base transition cannot be re-observed, blocks the batch before later children run.

In plugin flow, the internal plan token may be cached and reused only when session, repo, options, and dirty snapshot still match the plan. Blank token values and confirmation placeholders are treated as absent.

## Explicit Confirmation And Rescue Policy

Plan output and cached internal tokens are evidence, not approval. The OpenCode plugin and Codex adapter may inject a cached token only for `mode: "apply"` with explicit `confirm: true` and matching repo, session, target, and safety-relevant options. Neither adapter may synthesize confirmation, and a token alone never authorizes apply.

`guardian_done rescue=true` defaults to artifact-read-only planning. Plan builds the token-bound recovery candidate without mutating the real index, object store, refs, or worktree paths. Ignored-untracked residue is a blocker before recovery evidence is created. Only matching `confirm: true` apply may materialize the create-only recovery ref and clean only its bound paths; candidate, content, status, HEAD, timestamp, or token drift blocks.

Primary-main unconfirmed apply uses only the local plan facts and must not refresh. Matching confirmed apply refreshes remote facts, recomputes the token, and reports remote drift before safety-ref, commit, push, or cleanup mutation.

`guardian_finish_workflow` and `guardian_done` done-all unconfirmed apply reject before repository/config/base resolution, fetch or prune, candidate discovery, child planning, status inspection, final postflight, or token reconstruction. Matching confirmed apply performs fresh discovery and validates the exact plan before any cleanup or publication operation.

## `guardian_finish` Session Finish Policy

Use `guardian_finish` for explicit low-level Guardian worktree finishing. Prefer `guardian_done` for normal completion.

Finish always creates a safety ref before risky operations and reports preflight facts and blockers. Dirty worktrees block finish unless every dirty path matches explicit `allowDirtyPaths` config. Allowed dirty paths are reported as `allowedDirtyFiles` and left untouched. Guardian must not delete, stash, revert, stage, or commit allowed dirty files.

Low-level `push-branch` and `create-pr` finish modes publish the captured commit through an exact-OID normal push without force or lease and configure the local upstream only after push success. Non-fast-forward remote divergence blocks and leaves the remote head unchanged. Expected-head leased publication is reserved for the token-gated `guardian_done` active-session path.

If no active session owns the current checked-out worktree, `guardian_finish` may attach a fresh internal recovery session id when the current worktree is inside the configured Guardian worktree root, is not the primary repo worktree, is not detached, and is not on a protected branch. If a stale or terminal session id is present, that old session id is metadata only; it must not make an otherwise recoverable Guardian worktree unusable.

`create-pr` pushes the session branch and suggests a PR command; it does not create a PR natively. `merge-to-base` requires explicit approval via `allowMergeToBase: true`. Under that approval it may self-heal a clean primary repo worktree that is on the wrong branch: it creates safety refs for the primary worktree's original HEAD and the local base branch head, then repositions the primary worktree onto the base branch with a non-overwriting checkout before the fast-forward merge. A dirty primary worktree fails closed unless `allowBaseWorktreePreserveReset` is explicitly enabled per call or in repo config; under that opt-in Guardian snapshots the primary worktree's blocking dirt — including untracked files that `git stash create` would drop — into a recoverable safety ref, then resets only those paths clean with a path-scoped reset and clean that never removes the Guardian session worktrees living under the worktree root, before repositioning and merging. Guardian still never auto-creates a missing local base branch and never checks out the base branch while it is checked out in another worktree; those cases, plus any failed snapshot, incomplete clean, non-fast-forward merge, push failure, or remote-proof failure, fail closed with safety refs recorded. Cleanup can run only when `autoCleanup` or `allowCleanup` is enabled and ancestry is proven.

## `guardian_finish_workflow` Cleanup Policy

Use `guardian_finish_workflow` only after implementation is already committed, pushed, and merged to the configured base. Local base fast-forward is maintenance, not cleanup proof: if the local base worktree cannot be safely synced, apply must still run token-bound safe cleanup candidates and report the sync failure as a remaining blocker.

Run `mode: "plan"` first. The workflow verifies the primary worktree is clean, inventories repository-wide stashes, fetches the configured remote, and proves redundant cleanup candidates are already merged to the freshly resolved `remote/baseBranch` commit. Stash inventory is advisory unless repo config explicitly sets `requireEmptyStashInventory: true`. It discovers Guardian-root worktrees; local stale branches when `guardian_delete_worktree` can prove ownership from terminal Guardian state or matching safety refs; merged unchecked-out local branches under the configured cleanup prefix when ancestry to the resolved base is proven; and Guardian branch refs under `branchPrefix` on the resolved effective remote whose heads are ancestors of that base commit. The effective remote is the configured remote unless a trusted tracked upstream supplies the base ref. At most 25 cleanup candidates can be applied from one plan.

The candidate scan status is structured metadata. Invalid mode, base-unavailable, and strict stash-blocker preflights skip candidate discovery and must report skipped candidate scan status instead of completed zero-candidate evidence. Advisory stash inventory does not skip discovery. A dirty primary worktree remains a blocker, but `mode: "plan"` may continue through read-only cleanup inventory discovery after base evidence exists. When no independently safe candidates exist, that blocked inventory must not include a `confirmToken`. When independently safe candidates exist, the plan may return `planned-partial` with a token that authorizes only those candidates while the dirty primary blocker remains reported. Unexpected discovery failures report failed candidate scan status while preserving earlier preflight blockers.

Run `mode: "apply"` only with the returned token after explicit `confirm: true`. An unconfirmed apply rejects before repository/config/base resolution, fetch or prune, candidate discovery, child planning, status inspection, final postflight, or token reconstruction. The token binds the resolved base commit, `allowIgnoredFiles`, cleanup targets, exact direct-child tokens, create-only safety-ref identities, and every candidate's identity, remote action, and remote-branch presence state. Confirmed apply revalidates and uses those child tokens rather than re-planning changed state. Local branch refs are deleted only after Guardian creates the planned local safety ref and the ref still matches the token-bound expected head, so local base divergence cannot veto remote-base ancestry proof and advanced local refs still block. Remote branch reservations without a phase are legacy active reservations. New work persists `pending-proof` before creating the canonical direct non-symbolic raw commit OID ref at `refs/opencode-guardian/remote-branch-cleanup/`, then promotes it to active only after the proof exists; retry may create the ref or promote pending proof. Active retirement requires and preserves exact proof. Pending-proof retirement requires no ref and a strict descendant remote advance, preserves the remote branch, and has no safety ref to preserve. Absent reconciliation performs an empty-expectation leased compare-and-swap immediately before completion. Retirement-only work is counted by cleanup sweep and done-all, is bounded with omitted counts, performs no deletion, base sync, or final cleanup postflight, and requires a fresh plan before later deletion. It must not create commits, choose commit messages, merge protected branches, mutate stashes, force-delete local branches, delete unproven local stale branches, or run raw filesystem/Git cleanup. Candidate-level blockers do not suppress safe token-bound candidates; apply cleans safe candidates and returns `partial` with unresolved blockers still reported.

Apply requires a fresh plan token. Skipped or incomplete candidate scans, strict stash blockers, candidate-count bounds, stale or missing tokens, and dirty primary state with no safe candidates all block apply; none of those states permit cleanup from blocked inventory. A dirty primary blocker may coexist with a `planned-partial` token only when safe cleanup candidates are present, and that token authorizes only those safe candidates. Candidate-level blockers from a completed scan follow the same rule.

## Opt-In Clean Completion And Quarantine Policy

`goal.quarantineSessionResidue` is an explicit boolean opt-in and defaults to `false`. Omission and explicit `false` are behaviorally equivalent to the disabled path: Guardian does not capture clean-completion provenance, move residue into quarantine, persist a clean-completion proof, or change ordinary completion semantics. With the option enabled, cooperative provenance is evidence that a candidate is eligible under the captured session lineage and baseline; it is not proof of authorship, ownership, or a security identity.

The apply order is fixed: exact token-bound hygiene cleanup, then fingerprint- and lineage-bound quarantine, then the normal `guardian_done` or existing cleanup-workflow step. Commit inputs remain in the normal completion lane. Protected, tracked, baseline, mixed, symlinked, nested-Git, conflicting, missing, changed, or otherwise ambiguous candidates block instead of being silently deleted or quarantined.

Quarantine, restore, and purge staging move payloads only with non-overwriting atomic rename on the same device. Guardian has no copy-and-delete fallback; unavailable device identity or `EXDEV` fails closed with journaled recovery evidence preserved. Available quarantine items are retained indefinitely until an explicit restore or purge; Guardian never expires or purges them automatically.

`guardian_quarantine` restores to the original worktree only while it remains registered. Otherwise the caller must select a registered target worktree from the same repository, and restore refuses to overwrite an existing destination. Purge accepts only an `available` item and requires a matching plan token plus explicit `confirmDelete: true`; its durable sequence is prepared, atomic rename to a tombstone, tombstoned, payload removal, removed, item marked purged, then operation committed.

A clean-completion claim requires an identical stable two-pass, NUL-safe proof universe. That universe includes every registered worktree's status, tracked, and ignored inventories; the configured Guardian worktree root; the full Guardian metadata tree; Guardian state and journals; provenance and quarantine items; all Guardian refs; pending operations; tombstones, safety refs, and other recovery artifacts. Unknown, missing, changed, degraded, incomplete, or dirty evidence makes the proof unstable and prevents `complete` or clean wording.

`guardian_status` and `guardian_report_html` revalidate persisted proof against that current universe without mutating Git, worktrees, quarantine data, or Guardian state. Only a currently `proven` result may say the project is clean. Missing, stale, invalid, or inapplicable proof keeps the ordinary disclaimer: Guardian scope only; not a repo-cleanliness claim.

## `guardian_preserve` Policy

`guardian_preserve` marks the current Guardian worktree terminal/preserved and creates a preserved ref. It does not delete, clean, reset, stash, push, or merge. If no active session owns the current Guardian-root worktree, it may attach a fresh internal recovery session id first.

Preservation is not a permanent retention instruction. Preserved worktrees remain cleanup-eligible through `guardian_delete_worktree` once that tool proves deletion is safe.

## `guardian_unblock_finish` Policy

Use `guardian_unblock_finish` only when `guardian_finish` is blocked by narrow generated review-rating artifacts. It is not a broad cleanup or source-change commit tool.

Run `mode: "plan"` first. The supported action is `commit-review-artifacts`, which may commit only `.milestones/reviews/*impl-rating-YYYYMMDD.md` or `.milestones/reviews/*impl-rating-YYYYMMDD.txt` review artifacts. If Guardian state does not record the session, plan may resolve the current Guardian-root worktree or receive an explicit `branch` or `worktreePath` that resolves exactly one checked-out worktree under the configured Guardian worktree root.

Run `mode: "apply"` only with the fresh token and the same resolved current worktree, explicit branch, or explicit worktree path when state is still missing. Apply creates a safety ref, stages only approved review artifacts, commits them, and updates Guardian state. It refuses mixed dirty/source paths, renames/copies, symlink artifacts, deletions, ignored files, and cleanup. Stash inventory remains visible and advisory by default; `requireEmptyStashInventory: true` makes a non-empty inventory a blocker before safety-ref creation, staging, or commit.

## `guardian_delete_worktree` Worktree Deletion Policy

Use `guardian_delete_worktree` for stale, preserved, finished, orphaned, or explicitly abandoned Guardian worktree cleanup. Raw `git worktree remove`, `git worktree prune`, raw branch deletion, and filesystem deletion are forbidden substitutes.

Run `mode: "plan"` first. It resolves exactly one target by `targetPath`, `sessionId`, or `branch`, runs preflight checks, and returns a confirm token. Run `mode: "apply"` only with that token and the same options after explicit confirmation.

Apply recomputes the token from the normalized repo root, target kind, target path, worktree-listed state, branch or detached marker, HEAD, session identity/status, `deleteBranch`, `abandonUnmerged`, ancestry evidence, unmerged commits, `allowIgnoredFiles`, exact ignored path/content/symlink fingerprints, and planned safety-ref identity. Stale or missing tokens block.

Apply refuses primary repo worktree deletion, current execution worktree deletion, dirty or untracked targets by default, protected-branch worktrees even when `deleteBranch` is false, detached HEADs, and ignored files unless `allowIgnoredFiles: true` is present in both plan and apply. Repository stash inventory remains visible but advisory unless `requireEmptyStashInventory: true`, which requires an empty inventory during both plan and apply. The retired `allowStashIfUnrelated` key is ignored because Guardian does not infer stash ownership or path relationships. Passing the primary repo as `targetPath` remains blocked.

For opted-in ignored deletion, the token-bound ignored inventory is rechecked at the removal boundary immediately before non-force worktree removal. Observed drift blocks and requires a fresh plan with the updated inventory. If non-force removal fails, Guardian rescans and preserves the worktree and branch while reporting the current ignored inventory and requiring a fresh plan. Writes after the final check are outside the cooperative guarantee.

The dirty-target exception is `guardian_delete_worktree` with `allowRedundantDirtyPaths: true` in both plan and apply. `guardian_done` may use that exception only for an active recorded session whose head is already reachable from the fetched base ref; non-redundant dirty content remains blocked and must be preserved explicitly. Guardian must fetch the configured remote, resolve `baseRef` and `baseRefOid`, and prove every dirty path already matches the fetched base tree before token generation. Status-derived paths are staged and compared with literal pathspec semantics, so pathspec-looking names cannot be falsely proven redundant. Eligible paths are limited to unstaged tracked modifications, unstaged tracked deletions, and untracked regular files. Staged changes, mixed statuses, renames, copies, conflicts, submodules, symlinks, directories, type changes, ignored files, unreadable paths, and non-redundant content block. Apply creates the normal `safetyRef`, creates a `dirtySnapshotRef`, cleans only proof-approved paths internally, rechecks the target status, then uses the same non-force worktree removal. `guardian_finish_workflow` and cleanup-candidate sweeps remain fail-closed for dirty cleanup candidates and do not auto-pass this option.

Apply creates a safety ref before non-force worktree removal. Branch deletion is opt-in with `deleteBranch: true`; by default it requires ancestry proof, a branch checked out nowhere after any target worktree removal, and an exact expected-head local ref deletion.

## `guardian_delete_worktree` Orphan And Stale-Branch Policy

If a recorded Guardian session's worktree path is absent from `git worktree list`, or state points at the primary repo path while the recorded Guardian branch is checked out nowhere, `guardian_delete_worktree` can perform branch-only orphan cleanup with `deleteBranch: true`. It deletes no filesystem path, does not allow primary repo worktree deletion, verifies the branch exists, verifies it is checked out nowhere, verifies it is not protected, creates a safety ref, and deletes the local branch only when ancestry and exact expected-head checks pass.

If a local Guardian branch remains after its worktree and active state are gone, pass the exact `branch` or terminal `sessionId` with `deleteBranch: true` for stale-branch cleanup. Terminal states include `deleted`, `abandoned`, `finished`, and `preserved`. This branch-only path is allowed only when terminal Guardian state or matching `refs/opencode-guardian` safety refs prove ownership. Branch prefixes alone are not ownership proof.

## `guardian_delete_worktree` Unmerged Abandon Policy

Intentional unmerged local abandonment requires `deleteBranch: true` and `abandonUnmerged: true` in both plan and apply. Plan reports ancestry evidence, the base ref, and unmerged commits that remain recoverable from the safety ref.

Apply creates the safety ref first, then removes the clean Guardian worktree and deletes the local branch, recording the session as `abandoned`. This lane does not relax primary/current worktree, dirty-target, protected-branch, checked-out orphan branch, stale-token, strict stash-inventory, ignored-file, or missing-safety-ref blockers.

## `guardian_delete_paths` Exact Path Deletion Policy

Use `guardian_delete_paths` when the user intentionally wants to delete exact files or directories that are not Guardian hygiene findings, including source files.

Run `mode: "plan"` first with explicit `paths`. The plan reports each path's repo-relative path, absolute path, kind, tracked/ignored/untracked status, tracked contents, and blockers. Apply only after explicit confirmation with `mode: "apply"` and `confirmDelete: true`; low-level direct calls also require the matching `confirmToken`.

Tracked source deletion requires `allowTracked: true`. Directory deletion requires `allowRecursive: true`. Worktree deletion must use `guardian_delete_worktree`, not `guardian_delete_paths`.

The tool blocks paths outside the repo, the repo root, `.git`, `.opencode`, dependency roots such as `node_modules` and `vendor`, configured or registered Guardian worktree roots, the current worktree root, missing paths, symlink roots, overlapping selections, tracked contents without `allowTracked: true`, and directories without `allowRecursive: true`.

Apply re-runs the same fingerprinted preflight immediately before deletion, deletes files with internal Node `fs` APIs, and does not stage changes. Tracked deletions remain visible in `git status` for review and commit.

## `guardian_hygiene` Scan Policy

`guardian_hygiene` without `mode` is report-only. It detects untracked or ignored scratch artifacts, nested Git repositories, suspicious research dumps, generated cache roots, protected exclusions, and scan-only `reviewableCandidates`. Scan output does not authorize deletion. Protection is an authority boundary rather than a retention judgment: every protected root is measured with bounded file, directory, and byte totals, marked `not-assessed`, and carries `cleanupAuthorized: false`.

`reviewableCandidates` are the untracked or ignored candidate roots Guardian saw but did not classify as cleanup findings or protected exclusions. They are inventory for human review, not `findings`, not hygiene cleanup targets, and not accepted by the `guardian_hygiene` cleanup preflight. They do not increment finding, severity, category, risk, or approved-target counts.

The hygiene scan summary reports `candidateCount`, `findingCount`, `exclusionCount`, protected inventory root/file/directory/byte totals and truncation, `reviewableCandidateCount`, `reviewableShownCount`, `reviewableOmittedCount`, and `reviewableTruncated`. Readable scan output must keep protected inventory, reviewable entries, and findings separate, for example:

```text
[WARN] guardian_hygiene scan
[INFO] findings: 3 | warn: 2 | fail: 1 | exclusions: 1 | candidates: 8 | reviewable: 4
[WARN] protected inventory: 1 root | files: 12 | directories: 3 | bytes: 4096 | assessment: not-assessed | cleanup authorized: false
[WARN] top findings:
  - warn known-cleanable librarian-react: known librarian scratch artifact
  - fail nested-git test-hyperf-kafka: nested Git repository has uncommitted changes
[WARN] reviewable candidates: 4
[INFO] reviewable entries require exact-path guardian_delete_paths planning if cleanup is intended
  - ignored logs: not matched by Guardian hygiene cleanup rules
    guardian_delete_paths mode=plan paths=["logs"] allowRecursive=true
  - ignored plain.log: not matched by Guardian hygiene cleanup rules
    guardian_delete_paths mode=plan paths=["plain.log"]
```

If cleanup is intended for a reviewable file, the handoff is exact-path planning with `guardian_delete_paths mode=plan paths=["..."]`. If cleanup is intended for a reviewable directory, use `guardian_delete_paths mode=plan paths=["..."] allowRecursive=true`. Protected inventory must not receive suggested delete-path templates or become hygiene targets; changing protection or authorizing any exact deletion remains a separate explicit policy decision.

`guardian_status`, `guardian_recover`, and `guardian_hygiene` scan output are evidence-only surfaces. Research clones, downloaded upstream repos, generated fixtures, and temporary test data should live outside the active project tree, preferably under OS temp space such as `$TMPDIR/opencode/<repo>/<session>/`.

## `guardian_hygiene` Plan/Apply Cleanup Policy

`guardian_hygiene` is the single hygiene scan/plan/apply surface. Use `mode: "plan"` before cleanup; inspect exact approved targets, blockers, and summary; then get explicit user confirmation. Apply with `mode: "apply"` and `confirmDelete: true` using the same cleanup options.

Default cleanup includes current hygiene finding categories: known scratch artifacts, clean nested Git repositories, suspicious residue roots, generated `node-compile-cache/`, `node-coverage-*`, and `tsx-<digits>/` cache roots. Dirty `nested-git` findings require explicit `allowDirtyNestedGit: true`.

The plugin tool flow caches the plan token only for matching session, repo, and options. Empty token values and `CONFIRM_DELETE` placeholders are treated as absent; the cached token may be injected only when the plan matches. Low-level direct calls to `guardianHygiene` still require the matching `confirmToken`.

Apply re-runs preflight and removes only token-bound approved paths using internal Node `fs` APIs. It never suggests or shells out to broad cleanup commands. Cleanup blocks tracked files, protected directories, configured or registered Guardian worktrees, paths outside the repo root, `.git`, symlink cleanup roots, missing selected paths, stale fingerprints, and selected roots with unexpected tracked contents.

## `guardian_goal` Hygiene Completion Policy

`goal.hygieneCompletion` separates cleanup authorization from desired-state completion. Its default, `authorized-cleanup`, preserves legacy behavior: a goal can complete after authorized hygiene cleanup even when residual findings remain visible. `no-unprotected-findings` is findings-strict: after apply, Guardian rescans hygiene and completes only if no unprotected findings remain. `no-unprotected-residue` is inventory-strict: it additionally requires zero unprotected `reviewableCandidates` and complete reviewable and filesystem-only inventory coverage.

`allowedRemoteBranches` is a per-call exact-name retention list for the resolved effective remote. Guardian normalizes and deduplicates the list before token binding. Listed remote refs are excluded from remote cleanup candidate discovery and from strict extra-remote postflight blocking. A same-named local branch remains independently eligible for local cleanup. Plan and apply must use the same option set, including the normalized effective list, or the token does not authorize apply. This exception does not persist retention policy, broaden deletion authority, affect unscanned secondary remotes, or allow an unlisted remote branch.

This setting never broadens deletion. In every mode, `guardian_goal` auto-deletes only token-bound `known-cleanable` findings. Residual `nested-git` and `suspicious` findings require direct explicit review and are never auto-authorized. A dirty nested repository requires direct `allowDirtyNestedGit` for its own hygiene plan and apply. Configured `protectedPaths` deny deletion and are excluded from strict completion, while their bounded inventory remains visible as `not-assessed`; protection is not evidence that retained content is useful. `reviewableCandidates` remain inventory rather than hygiene targets; only `no-unprotected-residue` makes their unresolved presence a completion failure. Resolution remains explicit through retention-policy review or exact `guardian_delete_paths` planning.

Goal plans report `complete: null`. A strict plan with safe authorized work and residual unprotected findings, reviewables, or incomplete coverage can be actionable with `status: "planned-partial"`. Goal apply reports authorization and completion separately. A strict post-apply rescan can return `ok: true`, `complete: false`, and `status: "partial"`: Guardian performed the authorized work, but the desired state was not reached. Reviewable evidence is token-bound and reports an exact count and digest plus a bounded path list and omitted count. Prompt and TUI surfaces must inspect `complete` and `hygienePostcondition`; they must not equate `ok` with desired-state completion.

## `guardian_gc` State Record Cleanup Policy

`guardian_gc` prunes stale Guardian session records from state. It is record-only: it removes JSON session entries and never deletes git branches, worktrees, refs, stashes, or files. Nothing reachable becomes unreachable, so recovery refs and reflog remain available.

Run `mode: "plan"` first. Candidates are terminal sessions older than `safetyRefRetentionDays`, active sessions bound to the primary worktree or a protected branch (which validate and status already treat as poisoned), and active sessions whose worktree is absent from disk and from `git worktree list`. Healthy active sessions are never candidates. Apply with `mode: "apply"`, `confirmDelete: true`, and the returned `confirmToken`; the token binds the exact candidate set, and a changed set fails closed.

## Stale Tokens, Fingerprints, And Safety Ref Posture

Plan output is evidence, not approval. Apply must bind to the current preflight state through a fresh confirm token, cached internal token, or fingerprint appropriate to that tool surface.

Tokens and fingerprints must cover the target identity and safety-relevant options. Apply must re-run preflight and block when token data is stale, missing, mismatched, or derived from a different repo, session, dirty snapshot, base commit, path list, target, or cleanup option set.

Safety refs are required before risky finish, preserve, deletion, orphan cleanup, stale-branch cleanup, explicit unmerged abandon, and finish-unblock operations. Planned refs are created atomically and never overwritten. Retryable non-preserve finish, direct worktree deletion, and branch-only deletion may reuse the same planned ref only when it already resolves to the exact expected commit and the matching session recorded it; a different-target collision blocks. A successful branch-only retry terminalizes its unique exact-head session, clears stale deletion-failure fields, and records the safety ref once. Preserve, rescue, dirty-snapshot, and other recovery refs remain strictly create-only; a preserve collision returns a structured blocked result without mutating session state. Timestamp drift or any non-idempotent collision blocks instead of overwriting recovery evidence. Safety refs do not authorize raw cleanup or bypass plan/apply gates. Inside `guardian_done`, a safety ref or terminal Guardian state can prove ownership for token-bound stale local branch-only cleanup; unmerged abandon still records the abandoned commits and leaves recovery refs behind.

## Codex Adapter Hook Policy

The Codex adapter must route Guardian workflows through `codex/hooks/guardian-hook.ts` in this source repository, or through `node_modules/opencode-worktree-guardian/codex/hooks/guardian-hook.ts` after package install. Codex plugin hooks invoke the same adapter from `hooks/hooks.json`.

Codex has the same audit-default and strict-mode consequences as OpenCode: in default audit mode, the pre-tool hook exits successfully with no blocking response; `commandInterceptionMode: "strict"` blocks the same guarded command classes before mutation. Invalid configuration fails closed. This includes runtime aliases and executable paths, alternate executable paths, shell and stdin transport, dynamic ref destinations, recovery-ref roots and descendants, stash mutation, and protected-branch bypass attempts.

For `guardian_done`, `guardian_hygiene`, `guardian_delete_paths`, and `guardian_finish_workflow`, Codex usage must run plan first and apply only after explicit user confirmation with the same options. The adapter may reuse matching cached internal plan tokens but never treats a token as approval or creates confirmation; `guardian_done` injection requires `mode: "apply"` with `confirm: true`.

The Codex adapter must never replace Guardian workflows with raw `git reset --hard`, `git clean -fd`, `git worktree remove`, `git worktree prune`, `git branch -D`, `git stash drop`, `git stash clear`, force-push, broad filesystem deletion, or protected-branch bypass commands.

## Legacy Alias Deprecation And Removal Policy

Legacy command or tool aliases that overlap a current safety surface must be removed only as an intentional public-surface change. Removal must update native tool registries, slash command rewrites, TUI commands, packaged markdown commands, README, skills, package smoke expectations, and contract tests.

Removed aliases must not remain documented as active commands. Historical notes may mention them only as removed or deprecated legacy surfaces. The current hygiene cleanup authority is `guardian_hygiene` with scan, plan, and apply modes; there is no separate active hygiene cleanup alias.
