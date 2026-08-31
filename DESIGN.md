# Guardian Worktree Visualization Design Authority

## Source of truth

The Open Design sandbox is the binding visual authority for Guardian's offline worktree report:

- Dashboard: `git-worktree-dashboard.html` (`fcbd45f5202142602be69f3e7f71a5214037dfa04d0669b9f31a8e15871adf96`)
- Topology: `graph-topology.html` (`7b3a662d8b299509fd8d51538d75ac05a8c4e1b9f9c89bfdec69594218aed443`)
- Sandbox: `/Users/nashgao/Library/Application Support/Open Design/namespaces/release-stable/data/projects/551bfa5a-7a1a-4dac-a6c0-efd2062b5888`

These are implementation references, not mood boards. The report in this repository must preserve their layout, hierarchy, density, color, typography, responsive behavior, selection model, inspector, list/graph transition, and all seven topology modes.

## Fidelity contract

- The dashboard uses the Open Design application shell: 56px dark header, Worktree brand and repository chip, inline search and guidance controls, filter/sort toolbar, dense worktree table, graph toggle, and right-side inspector.
- The topology view uses the Open Design lifecycle-map shell: grid canvas, eyebrow and title, seven mode controls, large visualization stage, mode controls, legend, and selection detail panel.
- Reference viewports are 375px, 768px, and 1280px. A change is incomplete until the implemented report is checked at all three widths.
- Fixture records are replaced by typed Guardian status and recovery evidence. Missing facts stay visibly unavailable or unverified; the UI must not invent commit ancestry, timestamps, changed-file attribution, or lifecycle history.
- Simulated destructive actions are replaced by read-only Guardian guidance. Visual controls may retain the source design, but an offline report never mutates Git, worktrees, files, or sessions.
- Offline security remains authoritative: no remote fonts, network requests, unsafe DOM sinks, or executable user-controlled markup.
- Any further visual departure requires explicit user approval and must be recorded in this file. Local screenshots, computed styles, interaction results, and image diffs are disposable verification evidence rather than a second design authority.

## Runtime tokens

### Dashboard

| Role | Value |
|---|---|
| Background | `#0b0c0f` |
| Surface | `#13151a` |
| Raised surfaces | `#1a1d24`, `#22262e` |
| Foreground | `#f0f1f5` |
| Muted | `#8b8f99` |
| Accent | `#3bb273` |
| Information | `#59b8ff` |
| Warning | `#e5a443` |
| Danger | `#e45765` |
| Radii | `6px`, `10px`, `14px` |

### Topology

| Role | Value |
|---|---|
| Background | `oklch(15% 0.02 230)` |
| Surface | `oklch(21% 0.022 230)` |
| Panel | `oklch(25% 0.024 230)` |
| Border | `oklch(36% 0.03 230)` |
| Text | `oklch(95% 0.01 230)` |
| Accent | `oklch(82% 0.12 175)` |
| Success | `oklch(75% 0.22 145)` |
| Warning | `oklch(80% 0.14 85)` |
| Danger | `oklch(68% 0.18 25)` |
| Radius | `18px` |

The approved implementation boundaries are explicit: typed Guardian records replace fixtures; unavailable ancestry, lifecycle, attribution, and timing remain labeled rather than invented; mutation controls become report navigation or scoped guidance; the topology geometry is recalculated only from observed facts; visual events are capped at 64 with the complete set retained in Raw Data; and system font fallbacks replace remote Google Fonts. These boundaries are part of the faithful implementation contract, not permission for unrelated visual adaptation.
