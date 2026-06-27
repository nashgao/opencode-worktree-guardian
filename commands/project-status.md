---
description: Inspect project roadmap, milestone, plan, and ULW evidence through Guardian.
argument-hint: "[optional project root or writeReport=true]"
---

Use the native `guardian_project_status` tool to inspect project roadmap, milestone, plan, and ULW evidence.

Treat default output as read-only evidence. Keep notes, dashboards, copied status text, project registries, and repo-local status files out of this flow. Use `writeReport=true` only when the user explicitly wants the static offline HTML report at `.git/opencode-guardian/project-report.html`.

Project roots are explicit inputs for this run only. If the user provides roots, pass them as `projectRoots`; otherwise let Guardian scan the current repository root.

User request: $ARGUMENTS
