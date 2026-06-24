---
name: guardian-unblock-finish
description: Use when Guardian finish is blocked and the user asks to plan or apply safe blocker resolution.
---

# Guardian Unblock Finish

Plan blocker resolution through the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_unblock_finish '{"mode":"plan"}'
```

The supported action is `commit-review-artifacts`, which may commit only matching `.milestones/reviews/*impl-rating-YYYYMMDD.md` or `.milestones/reviews/*impl-rating-YYYYMMDD.txt` artifacts. Apply only after explicit confirmation with `mode: "apply"` and the same target options.

Do not delete files, stash, clean, force-push, rename or copy source files into review artifacts, commit symlink artifacts, or commit source changes.
