# Operations Center

`guardian_report_html` writes a self-contained, offline Operations Center at `.git/opencode-guardian/report.html`. It is a cached, read-only view of the repository facts available when Guardian generated the file. The report has four views:

- **Operations** for the observed worktree inventory, filters, selection, metrics, risks, and non-mutating action guidance.
- **Topology** for seven evidence-labeled presentations of the same inventory.
- **Evidence** for Guardian's rendered verdict, base authority, recovery, and operational facts.
- **Raw Data** for the preserved structured `status` and `recover` results.

The report can identify a risk or suggest a next step, but it never executes Guardian or Git mutations. Its action controls select or copy guidance only. The canonical policy for mutation, deletion, confirmation, routing, and lifecycle operations remains [ADR 0001: Threat Model and Concurrency Boundary](adr/0001-guardian-safety-policy.md). This document describes the report surface and defers to that ADR for all policy decisions.

## Evidence Boundary

The report starts with the live results returned by `GuardianStatusResult` and `GuardianRecoverResult`, then constructs its display data through `buildOperationsCenterModel` and `buildTopologyDisplayModel`. `actionGuidance` is precomputed for each selection, while the Evidence and Raw Data views preserve the rendered evidence and original structured results rather than replacing them with inferred summaries.

The report labels missing or unverified facts instead of filling gaps. It does not have commit ancestry, parentage, branch-point, or chronology facts. It cannot assign the repository-wide dirty-file inventory to an individual worktree. When supplied timestamps are absent, it does not infer lifecycle intervals or staleness.

## Topology Boundary

Topology offers these exact modes: `metro`, `radar`, `timeline`, `gittree`, `sunburst`, `swimlanes`, and `terminal`.

Every mode represents the observed worktrees and events available to the report. Relationships from the primary worktree are marked unverified, not presented as Git graph edges. `timeline` and `swimlanes` show only supplied events and do not create lifecycle intervals. `gittree` does not claim commit parentage, ancestry, branch points, or chronology. `radar` does not claim staleness or lifecycle meaning without timestamps. `sunburst` ordering is illustrative, not ancestry or priority. The Terminal mode is the semantic alternative: it keeps the same facts in a text-first representation.

## Offline Security And Write Boundary

The generated HTML has one CSP-hashed executable controller and one CSP-hashed stylesheet. Report data is serialized as inert, escaped JSON. The CSP permits no remote or network sources, and the controller avoids unsafe DOM sinks. It renders through safe DOM APIs rather than HTML injection APIs.

Opening, filtering, selecting, or reading the report cannot run Guardian or Git mutations. `guardian_report_html` retains the existing atomic, symlink-safe report-write path. Writing the file is the tool's only filesystem effect.

## Accessibility And Responsive Behavior

The report provides a skip link, named tab panels, keyboard-operable view and topology selectors, selection state, and focus-visible controls. Operations filtering and selected-record guidance remain available without turning controls into mutations. Responsive layouts preserve owner and state information, and reduced-motion preferences are respected. The Terminal topology view remains the semantic, text-first alternative to graphical layouts.

## Open Design Provenance

The Operations Center adapted visual and interaction grammar from these local import sources:

```text
/Users/nashgao/Library/Application Support/Open Design/namespaces/release-stable/data/projects/551bfa5a-7a1a-4dac-a6c0-efd2062b5888/git-worktree-dashboard.html
/Users/nashgao/Library/Application Support/Open Design/namespaces/release-stable/data/projects/551bfa5a-7a1a-4dac-a6c0-efd2062b5888/graph-topology.html
/Users/nashgao/Library/Application Support/Open Design/namespaces/release-stable/data/projects/551bfa5a-7a1a-4dac-a6c0-efd2062b5888/worktree-visualizations.html
/Users/nashgao/Library/Application Support/Open Design/namespaces/release-stable/data/projects/551bfa5a-7a1a-4dac-a6c0-efd2062b5888/DESIGN.md
```

These paths are local provenance references, not repository documentation links. Guardian adapted only visual and interaction grammar. It did not import fixture mutations, raw Git actions, or history semantics that Guardian cannot support with evidence.

## Developer Verification

Run the focused report and topology tests while changing this surface:

```bash
node scripts/with-safe-node-temp.mjs -- node --import tsx --test test/operations-center-model.test.ts test/operations-center-guidance.test.ts test/operations-center-dashboard.test.ts test/operations-center-topology.test.ts test/report.test.ts
```

Run `npm run verify` for the project verification suite. Before release, browser QA should exercise the complete view, selection, keyboard, responsive, reduced-motion, and topology-mode matrix from a generated report. These are developer verification entry points, not a statement of current verification status.
