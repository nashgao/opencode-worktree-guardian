# Release Checklist

Use this checklist before any public package publication. Run it from the repository root on a clean release branch.

## Preconditions

- `package.json` names the intended package, version, exports, files, scripts, engines, repository, license, and `prepublishOnly` policy.
- `CHANGELOG.md` has an `Unreleased` section and does not claim a version has shipped before publication.
- `README.md`, `docs/adr/0001-guardian-safety-policy.md`, OpenCode command docs, OpenCode skill docs, and Codex adapter docs describe the same public tool surface.
- The worktree contains only intentional release changes.
- No `npm publish` command has been run from this checklist.

## Required Commands

```bash
npm run test:readiness
npm audit --registry=https://registry.npmjs.org --omit=dev --audit-level=low
npm pack --dry-run --json
```

The release is blocked if any required command exits non-zero, reports a dependency audit issue at or above the configured audit level, or shows an unexpected package file list.

## Package Dry-Run Inspection

Inspect `npm pack --dry-run --json` output and confirm the package includes the expected public assets:

- `README.md`
- `LICENSE`
- `CHANGELOG.md`
- `commands/`
- `skills/`
- `src/`
- `scripts/`
- `codex/`
- `docs/`

Confirm the output does not include local evidence files, worktree state, test logs, untracked scratch directories, or generated caches.

## OpenCode Host Check

Run the deterministic host smoke before manual host validation:

```bash
npm run test:smoke:host
```

For manual QA, use a disposable Git repository only:

1. Install or shim the release candidate into the disposable repo.
2. Start OpenCode from that disposable repo.
3. Confirm the Guardian plugin loads and exposes `guardian_status`.
4. Confirm `guardian_status` returns repository inventory.
5. Confirm a safe Git write is routed into the Guardian-owned worktree when ownership exists.
6. Confirm a raw destructive command such as `git reset --hard` is blocked before mutation.

Do not validate manual OpenCode behavior against a live project repository.

## Codex Adapter Check

Run the Codex adapter smoke coverage before publication:

```bash
npm run test -- test/codex-adapter.test.ts test/package-smoke.test.ts
```

Then inspect `npm pack --dry-run --json` output and confirm the packed package contains:

- `codex/.codex-plugin/plugin.json`
- `codex/hooks/hooks.json`
- `codex/hooks/guardian-hook.ts`
- `codex/skills/worktree-guardian/SKILL.md`

For manual QA, invoke the adapter only in a disposable Git repository. Confirm `guardian_status` returns readable output and the pre-tool hook blocks a raw destructive command such as `git reset --hard`.

## Final Gate

Publish only when:

- all required commands pass,
- OpenCode host smoke and manual host checks pass,
- Codex adapter tests and manual adapter checks pass,
- `npm pack --dry-run --json` contains exactly the intended public package surface,
- `CHANGELOG.md` has been updated for the release without inventing unpublished history,
- the git tag and package version policy in `docs/publishing.md` is satisfied.
