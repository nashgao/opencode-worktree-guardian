# Changelog

All notable public-surface changes are tracked here.

## Unreleased

No changes.

## 0.1.0 - 2026-06-13

### Added

- Packaged Codex adapter surface under the `./codex` export and `codex/` package files, with adapter smoke coverage.
- Canonical Guardian safety policy in `docs/adr/0001-guardian-safety-policy.md`.
- Public release hygiene documentation in `docs/release-checklist.md` and `docs/publishing.md`.
- Contract and package smoke coverage for public native tools, slash commands, packaged command assets, package exports, package files, and Codex adapter files.

### Changed

- Documented `guardian_hygiene` as the single hygiene scan, plan, and apply surface.
- Clarified README safety guidance to point at the canonical safety policy.

### Removed

- Removed the legacy `guardian_hygiene_cleanup` and `hygiene-cleanup` public command surfaces in favor of `guardian_hygiene`.
