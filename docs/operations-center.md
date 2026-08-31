# Operations Center

`guardian_report_html` writes a self-contained, offline Operations Center at `.git/opencode-guardian/report.html`. It is a cached, read-only view of the repository facts available when Guardian generated the file. The report has four views:

- **Operations** for the Open Design Worktree dashboard: observed inventory, search, filters, list/graph selection, inspector, and non-mutating action guidance.
- **Topology** for the Open Design lifecycle map and its seven evidence-labeled presentations of the same inventory.
- **Evidence** for Guardian's rendered verdict, base authority, recovery, and operational facts.
- **Raw Data** for the preserved structured `status` and `recover` results.

The report can identify a risk or suggest a next step, but it never executes Guardian or Git mutations. Its action controls select or copy guidance only. The canonical policy for mutation, deletion, confirmation, routing, and lifecycle operations remains [ADR 0001: Threat Model and Concurrency Boundary](adr/0001-guardian-safety-policy.md). This document describes the report surface and defers to that ADR for all policy decisions.

## Evidence Boundary

The report starts with the live results returned by `GuardianStatusResult` and `GuardianRecoverResult`, then constructs its display data through `buildOperationsCenterModel` and `buildTopologyDisplayModel`. `actionGuidance` is precomputed for each selection, while the Evidence and Raw Data views preserve the rendered evidence and original structured results rather than replacing them with inferred summaries.

The report labels missing or unverified facts instead of filling gaps. It does not have commit ancestry, parentage, branch-point, or chronology facts. It cannot assign the repository-wide dirty-file inventory to an individual worktree. When supplied timestamps are absent, it does not infer lifecycle intervals or staleness.

## Topology Boundary

Topology offers these exact modes: `metro`, `radar`, `timeline`, `gittree`, `sunburst`, `swimlanes`, and `terminal`.

Every mode represents the observed worktrees and events available to the report. Relationships from the primary worktree are marked unverified, not presented as Git graph edges. Visual event projections are bounded to 64 deterministically ordered entries and report the omitted count; the complete structured events remain in Raw Data. `timeline` and `swimlanes` show only supplied events and do not create lifecycle intervals. `gittree` does not claim commit parentage, ancestry, branch points, or chronology. `radar` does not claim staleness or lifecycle meaning without timestamps. `sunburst` ordering is illustrative, not ancestry or priority. The Terminal mode is the semantic alternative: it keeps the same facts in a text-first, internally scrollable representation.

## Offline Security And Write Boundary

The generated HTML has one CSP-hashed executable controller and one CSP-hashed stylesheet. Report data is serialized as inert, escaped JSON. The CSP permits no remote or network sources, and the controller avoids unsafe DOM sinks. It renders through safe DOM APIs rather than HTML injection APIs.

Opening, filtering, selecting, or reading the report cannot run Guardian or Git mutations. `guardian_report_html` retains the existing atomic, symlink-safe report-write path. Writing the file is the tool's only filesystem effect.

## Accessibility And Responsive Behavior

The report provides a skip link, named tab panels, keyboard-operable view and topology selectors, selection state, and focus-visible controls. Operations filtering and selected-record guidance remain available without turning controls into mutations. At 1020px the inspector becomes the Open Design overlay; at 720px the header and toolbar wrap and the source design hides the commit/action columns while retaining branch, path, and status. Reduced-motion preferences are respected. The Terminal topology view remains the semantic, text-first alternative to graphical layouts.

## Open Design Provenance

The Operations Center migrates the complete dashboard and topology presentation from these local Open Design sources:

```text
/Users/nashgao/Library/Application Support/Open Design/namespaces/release-stable/data/projects/551bfa5a-7a1a-4dac-a6c0-efd2062b5888/git-worktree-dashboard.html
/Users/nashgao/Library/Application Support/Open Design/namespaces/release-stable/data/projects/551bfa5a-7a1a-4dac-a6c0-efd2062b5888/graph-topology.html
```

These paths are local provenance references, not repository documentation links. The binding source hashes are recorded in [`DESIGN.md`](../DESIGN.md): dashboard `fcbd45f5202142602be69f3e7f71a5214037dfa04d0669b9f31a8e15871adf96` and topology `7b3a662d8b299509fd8d51538d75ac05a8c4e1b9f9c89bfdec69594218aed443`.

The implementation preserves the source application shell, density, colors, responsive behavior, list/graph selection, inspector, grid topology canvas, side panel, and seven mode controls. It intentionally replaces only three fixture-only boundaries:

1. Guardian's typed `status` and `recover` records replace sample worktrees.
2. Facts Guardian does not possess remain unavailable or unverified instead of being invented.
3. Simulated Add, Sync, Pull, Open, Terminal, and Remove mutations become scoped read-only guidance or report navigation.

The implementation boundaries are the evidence and safety substitutions above, deterministic 64-event visual projection, topology geometry calculated only from observed facts, and system-font fallbacks required by the offline CSP. They are recorded rather than hidden because the report must not claim fixture facts it cannot prove. Future departures require explicit approval under `DESIGN.md`; “inspired by” or partial adaptation is not the implementation contract.

## Developer Verification

Run the focused report and topology tests while changing this surface:

```bash
node scripts/with-safe-node-temp.mjs -- node --import tsx --test test/open-design-fidelity-contract.test.ts test/operations-center-model.test.ts test/operations-center-guidance.test.ts test/operations-center-dashboard.test.ts test/operations-center-topology.test.ts test/report.test.ts
```

Run `npm run verify` for the project verification suite. Before release, browser QA should exercise the complete view, selection, keyboard, responsive, reduced-motion, and topology-mode matrix from a generated report. These are developer verification entry points, not a statement of current verification status.
