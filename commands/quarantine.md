---
description: Plan a single quarantined item restore or permanent purge through Guardian.
argument-hint: "action=restore|purge quarantineId=<id> [targetWorktreePath=<registered path>]"
---

Use the native `guardian_quarantine` tool. First run `mode=plan` with one exact `action` and `quarantineId`. The plan returns a `confirmToken` bound to those arguments, the selected target, and the current item. For `mode=apply`, repeat the exact plan arguments; the Guardian adapter supplies its matching cached token, while a direct native caller must include the exact returned `confirmToken`. Never ask the user to copy an internal token.

For `restore`, Guardian selects the original worktree only while it remains registered. If it is gone, inspect `eligibleTargetWorktreePaths` and select one exact `targetWorktreePath` that remains a registered worktree of the same repository. Apply only with the same arguments and explicit `confirm=true`. Restore never overwrites an existing destination.

For `purge`, verify the single selected item is still `available`, then apply only with the same arguments and explicit `confirmDelete=true`. Purge is permanent and cannot be undone.

Quarantine, restore, and purge staging use non-overwriting same-device renames only. Unavailable device identity or `EXDEV` blocks the operation; there is no copy-and-delete fallback. Available items are retained indefinitely until explicit restore or purge, with no automatic expiry or purge. Never use raw deletion or move commands for quarantine data.

User request: $ARGUMENTS
