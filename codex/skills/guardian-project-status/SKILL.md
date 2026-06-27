---
name: guardian-project-status
description: Use when the user asks Guardian to inspect project roadmap, milestone, plan, or ULW execution evidence.
---

# Guardian Project Status

Run the Guardian Codex adapter instead of creating separate project notes or dashboards:

```bash
node <adapter-path> tool guardian_project_status '{}'
```

Use `projectRoots` only for explicit roots supplied by the user. Default output is read-only evidence. Use `writeReport:true` only when the user explicitly asks for the offline static project intelligence report at `.git/opencode-guardian/project-report.html`.

Keep Obsidian notes, copied status text, project registries, and repo-local status markdown out of this flow.
