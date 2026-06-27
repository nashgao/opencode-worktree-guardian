---
name: worktree-guardian
description: Use when the user asks Codex to run Guardian workflows such as guardian status, guardian done, guardian finish, guardian recover, or worktree cleanup. Routes through the Codex Guardian adapter instead of raw git cleanup commands.
---

# Worktree Guardian for Codex

Use the packaged Codex adapter CLI instead of raw destructive shell commands. In this source repository the adapter path is `codex/hooks/guardian-hook.ts`; after npm install it is `node_modules/opencode-worktree-guardian/codex/hooks/guardian-hook.ts`. Codex plugin hooks invoke the same adapter from `hooks/hooks.json`.

Canonical safety policy: [ADR 0001: Guardian Safety Policy](../../../docs/adr/0001-guardian-safety-policy.md).
Release checklist: [docs/release-checklist.md](../../../docs/release-checklist.md). Publishing policy: [docs/publishing.md](../../../docs/publishing.md).

## Commands

- `guardian status` -> run `node <adapter-path> tool guardian_status '{}'`
- `guardian project-status` -> run `node <adapter-path> tool guardian_project_status '{}'`
- `guardian done` -> run `node <adapter-path> tool guardian_done '{"mode":"plan"}'` first. If the active session is dirty, include an explicit `commitMessage`; Guardian will not invent one. After explicit user confirmation, rerun with `{"mode":"apply","confirm":true}` plus the same plan options. Active-session apply commits dirty work when needed, lands the PR, proves the commit reached the remote base branch, then removes the stale worktree and local branch. Add `allowAdminBypass:true` only when the user explicitly approves a branch-protection bypass; do not copy or ask for the internal confirm token.
- `guardian finish` -> prefer `guardian_done` for normal completion. Use `node <adapter-path> tool guardian_finish '{}'` only for explicit low-level session finishing when the user asks for that tool.
- `guardian recover` -> run `node <adapter-path> tool guardian_recover '{}'`
- `guardian hygiene` -> run `node <adapter-path> tool guardian_hygiene '{}'` first to inventory findings, exclusions, and scan-only `reviewableCandidates`. For approved cleanup findings, run `node <adapter-path> tool guardian_hygiene '{"mode":"plan"}'` with the intended cleanup options. After explicit delete confirmation, rerun with `{"mode":"apply","confirmDelete":true}` and the same cleanup options; the adapter reuses the matching cached plan token.
- `guardian delete paths` -> run `node <adapter-path> tool guardian_delete_paths '{"mode":"plan","paths":[...]}'` first for exact file or directory deletion. Apply only after explicit delete confirmation with `{"mode":"apply","confirmDelete":true}` and the same options; use `allowTracked` or `allowRecursive` only when explicitly intended.
- `guardian delete worktree` -> run `node <adapter-path> tool guardian_delete_worktree '{"mode":"plan"}'` with an exact `targetPath`, `sessionId`, or `branch`. Apply only after explicit confirmation with the returned token and the same options.

## Rules

For `guardian done`, `guardian_delete_paths`, `guardian_delete_worktree`, and `guardian_finish_workflow`, always run `mode=plan` first. For `guardian_hygiene`, start with the default scan, then use `mode=plan` only for approved cleanup findings. Apply only after explicit user confirmation and only with the same options requested by the plan. Use `confirm=true` for done or finish-workflow apply, and `confirmDelete=true` for hygiene or exact path deletion apply. Never add `allowAdminBypass:true` unless the user explicitly approved it for that run. Do not ask the user to copy internal confirm tokens when using the Codex adapter CLI.

Never replace Guardian workflows with raw `git reset --hard`, `git clean -fd`, `git worktree remove`, `git worktree prune`, `git branch -D`, `git stash drop`, `git stash clear`, or force-push commands.

Use `guardian_project_status` for project evidence snapshots, `guardian_hygiene` for hygiene cleanup, `guardian_delete_paths` for exact path/source deletion, `guardian_delete_worktree` for worktree deletion, and `guardian_done` for normal completion.
