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

`reviewableCandidates` are inventory, not hygiene targets. For intentional reviewable cleanup, run `guardian_delete_paths mode=plan paths=["..."]`. Directories also require `allowRecursive=true`. Review target status and blockers before explicit confirmation, then apply through `guardian_delete_paths` with `confirmDelete=true`. Do not pass reviewables back to `guardian_hygiene`, and never run raw cleanup commands.

The scan inventory is read-only and complete when coverage is complete: relay findings, reviewable paths, and filesystem-only empty directories with their counts. `omitted: 0` means every returned root was shown. If filesystem traversal is marked incomplete, report that coverage failure rather than claiming a clean workspace.
