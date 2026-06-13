# Publishing Policy

This project publishes only from an intentional release branch after the release checklist passes. Do not run `npm publish` from routine development or remediation tasks.

## Versioning Policy

- The package uses semver.
- Patch versions are for compatible fixes, documentation updates shipped with the package, and release-process corrections.
- Minor versions are for new compatible public Guardian surfaces, new host or adapter support, or substantial safety-policy additions.
- Major versions are for breaking public-surface changes, removed commands or tools, changed confirmation semantics, changed package exports, or changed host requirements.
- `package.json` is the source of the package version being prepared. `CHANGELOG.md` records public-surface changes but must not claim the version has been published until publication has happened.

Before publishing, update the version intentionally with npm's versioning flow or another explicit semver change. Do not change the version as a side effect of unrelated work.

## What Must Be True Before Publishing

- `docs/release-checklist.md` has been completed.
- `npm run test:readiness` exits 0.
- `npm audit --registry=https://registry.npmjs.org --omit=dev --audit-level=low` exits 0.
- `npm pack --dry-run --json` has been inspected and contains only intended package files.
- OpenCode host smoke and manual disposable-repo host QA have passed.
- Codex adapter tests and manual disposable-repo adapter QA have passed.
- The README, safety policy, OpenCode skill docs, Codex skill docs, and packaged command docs agree on the same public surface.
- `CHANGELOG.md` has a dated section for the version being published, moved from `Unreleased`, with no claim that the version shipped before the publish actually happens.
- The worktree is clean except for intentional release changes.

## npm Publish Notes

Use npm's dry run before publication:

```bash
npm pack --dry-run --json
```

Use npm publish only after the dry-run package contents and release checklist are accepted:

```bash
npm publish --access public
```

Do not publish if the package includes local evidence files, `.omo/`, `.milestones/`, `.worktrees/`, generated caches, test output, or untracked scratch data.

If publication fails after a version bump or tag was created locally, do not reuse ambiguous state. Record the failure, inspect npm and git state, and either retry the same unchanged artifact when safe or prepare a new patch version.

## Commit And Tag Policy

- The release commit should contain the version bump, changelog entry, and any release-only documentation updates.
- Tag only the commit that was actually published.
- Use an annotated git tag named `v<version>`, for example `v0.1.0`.
- Push the tag only after `npm publish` succeeds for the same version.
- If `npm publish` has not succeeded, do not create or push a release tag that implies the package is public.

## Post-Publish Checks

After publish, verify the package metadata and install path from npm, then update release notes if the project uses GitHub releases. Do not backfill the changelog with unverifiable claims; record only what was actually published and tagged.
