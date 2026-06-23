---
name: guardian-hygiene
description: Use when the user asks Guardian to scan hygiene findings, review workspace residue, or plan/apply safe cleanup of approved findings.
---

# Guardian Hygiene

Start with a read-only scan:

```bash
node <adapter-path> tool guardian_hygiene '{}'
```

For cleanup, run `mode: "plan"` first with the intended cleanup options. Inspect exact approved targets and blockers. Apply only after explicit delete confirmation with `mode: "apply"`, `confirmDelete: true`, and the same options.

`reviewableCandidates` are scan-only inventory, not cleanup findings. Use `guardian-delete-paths` for intentional exact-path cleanup of reviewable files or directories.
