---
name: guardian-quarantine
description: Use when the user asks Guardian to restore or permanently purge one quarantined residue item.
---

# Guardian Quarantine

Run the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_quarantine '{"mode":"plan","action":"restore|purge","quarantineId":"..."}'
```

Treat the plan as read-only evidence. Its `confirmToken` binds the action, item, selected target, and current item digest. After explicit user confirmation, repeat the exact plan arguments with `mode:"apply"`; the Codex adapter supplies the matching cached token. A direct native caller must instead include the exact returned `confirmToken`. Never ask the user to copy it.

Restore defaults to the recorded original worktree only while it remains registered. If it is gone, choose one exact `targetWorktreePath` from `eligibleTargetWorktreePaths`; the target must remain a registered worktree of the same repository. Apply restore only with `confirm:true`, and never overwrite an existing destination.

Purge permanently removes exactly one `available` item. Apply it only with `confirmDelete:true`.

Quarantine, restore, and purge staging use non-overwriting same-device renames only. Unavailable device identity or `EXDEV` blocks with no copy-and-delete fallback. Available items remain retained indefinitely until explicit restore or purge; Guardian never expires or purges them automatically. Never use raw delete or move commands for quarantine artifacts.
