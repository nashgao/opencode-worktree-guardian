import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { OPERATIONS_CENTER_CONTROLLER } from "../src/operations-center/controller.ts";
import { renderGuardianReportHtml } from "../src/report.ts";
import { REPORT_CSS } from "../src/report-css.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianRecover, guardianStatus } from "../src/recover.ts";
import { createRepo } from "./helpers.ts";

class RuntimeEvent {
  public defaultPrevented = false;
  public metaKey = false;
  public ctrlKey = false;

  public constructor(readonly type: string, readonly target: RuntimeElement, readonly key = "", readonly deltaY = 0, readonly clientX = 0, readonly clientY = 0) {}

  public preventDefault() {
    this.defaultPrevented = true;
  }
}

class RuntimeElement {
  public id = "";
  public className = "";
  public hidden = false;
  public value = "";
  public type = "";
  public readonly children: RuntimeElement[] = [];
  public readonly classList = { toggle: (_name: string, _active: boolean) => undefined };
  private text = "";
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: RuntimeEvent) => void)[]>();

  public constructor(private readonly runtime: RuntimeDocument) {}

  public get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  public set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
  }

  public append(...children: RuntimeElement[]) {
    this.children.push(...children);
  }

  public replaceChildren(...children: RuntimeElement[]) {
    this.text = "";
    this.children.length = 0;
    this.children.push(...children);
  }

  public setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  public addEventListener(name: string, listener: (event: RuntimeEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  public dispatch(event: RuntimeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  public focus() {
    this.runtime.activeElement = this;
  }

  public closest(selector: string) {
    return this.matches(selector) ? this : null;
  }

  public querySelector(selector: string) {
    return this.runtime.query(selector, this)[0] ?? null;
  }

  public matches(selector: string) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const attribute = selector.match(/^\[([^=\]]+)(?:=([^\]]+))?\]$/);
    if (!attribute) return false;
    const [, name, value] = attribute;
    return value ? this.getAttribute(name) === value : this.getAttribute(name) !== null;
  }
}

class RuntimeDocument {
  public readonly body = new RuntimeElement(this);
  public activeElement: RuntimeElement | null = null;
  private readonly listeners = new Map<string, ((event: RuntimeEvent) => void)[]>();

  public getElementById(id: string) {
    return this.query(`#${id}`)[0] ?? null;
  }

  public querySelectorAll(selector: string) {
    return this.query(selector);
  }

  public querySelector(selector: string) {
    return this.query(selector)[0] ?? null;
  }

  public query(selector: string, root = this.body): RuntimeElement[] {
    return root.children.flatMap((child) => [child, ...this.query(selector, child)]).filter((element) => element.matches(selector));
  }

  public createElement() {
    return new RuntimeElement(this);
  }

  public createElementNS() {
    return new RuntimeElement(this);
  }

  public addEventListener(name: string, listener: (event: RuntimeEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  public dispatch(event: RuntimeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

function element(document: RuntimeDocument, id = "", attributes: readonly (readonly [string, string])[] = []) {
  const node = document.createElement();
  node.id = id;
  for (const [name, value] of attributes) node.setAttribute(name, value);
  document.body.append(node);
  return node;
}

function worktree(id: string, path: string) {
  return { id, path, branch: `guardian/${id}`, head: "abcdef", flags: { primary: id === "a", linked: id !== "a", detached: false, bare: false }, owner: { sessionId: `ses_${id}`, status: "active" }, state: "active", tone: "good", risk: { external: false, orphaned: false, poisoned: false }, baseDistance: { status: "available", baseRef: "origin/main", relation: "equal", ahead: 0, behind: 0 } };
}

function runtime(events: readonly { readonly kind: string; readonly sessionId: string; readonly at: string | null; readonly action: null }[] = [], worktreeCount = 2) {
  const document = new RuntimeDocument();
  const worktrees = Array.from({ length: worktreeCount }, (_, index) => worktree(String.fromCharCode(97 + index), `/repo/${String.fromCharCode(97 + index)}`));
  const [a, b] = worktrees;
  assert.ok(a);
  assert.ok(b);
  b.state = "terminal";
  b.risk.external = true;
  const action = (path: string) => ({ id: "switch", title: "Open selected worktree", instruction: `Selected path: ${path}. Open an OpenCode session at that path, then use guardian_status. This report does not switch worktrees.` });
  const modes = ["metro", "radar", "timeline", "gittree", "sunburst", "swimlanes", "terminal"];
  const payload = { model: { worktrees, topology: { modes, worktrees, primaryWorktreeId: a.id, edges: worktrees.slice(1).map((item) => ({ from: a.id, to: item.id, verification: "unverified" })), events, unavailable: { timeline: "Unavailable", gitTree: "Commit ancestry, parentage, branch point, and chronology are unavailable/unverified", radar: "illustrative", sunburst: "illustrative", swimlanes: "Unavailable" } }, actions: [{ id: "switch" }], raw: {} }, guidance: { fallback: { actions: [action("the selected worktree path")] }, worktrees: worktrees.map((item) => ({ worktreeId: item.id, actions: [action(item.path)] })) } };
  const source = element(document, "guardian-report-data");
  source.textContent = JSON.stringify(payload);
  element(document, "operations-list"); element(document, "operations-graph"); element(document, "operations-graph-svg");
  const inspector = element(document, "operations-inspector-content");
  inspector.append(element(document, "guidance-title"), element(document, "guidance-text"), element(document, "guidance-copy"));
  element(document, "operations-search"); const sort = element(document, "operations-sort"); sort.value = "branch"; element(document, "raw-json");
  for (const filter of ["all", "active", "terminal", "risk", "unmanaged"]) { const button = element(document, "", [["data-filter", filter]]); button.append(element(document, "", [["data-filter-count", filter]])); }
  for (const view of ["list", "graph"]) element(document, "", [["data-view", view]]);
  for (const tab of ["operations", "topology", "evidence", "raw-data"]) { element(document, `tab-${tab}`, [["role", "tab"], ["aria-controls", `panel-${tab}`]]); element(document, `panel-${tab}`, [["role", "tabpanel"]]); }
  const copied: string[] = [];
  vm.runInNewContext(OPERATIONS_CENTER_CONTROLLER, { document, navigator: { clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } }, window: { clearTimeout: () => undefined, setTimeout: () => 0 } });
  return { document, copied };
}

test("Given a generated report, when rendering Operations, then it exposes the live dashboard control contract", async (t) => {
  // Given
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: repo, config: DEFAULT_CONFIG });

  // When
  const html = renderGuardianReportHtml({ reportPath: "report.html", generatedAt: "2026-08-13T12:00:00.000Z", status, recover });

  // Then
  for (const id of ["operations-search", "operations-filters", "operations-sort", "operations-list", "operations-graph", "operations-inspector"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const filter of ["all", "active", "terminal", "risk", "unmanaged"]) assert.match(html, new RegExp(`data-filter="${filter}"`));
  for (const sort of ["branch", "path", "state", "base-distance"]) assert.match(html, new RegExp(`value="${sort}"`));
  for (const view of ["list", "graph"]) assert.match(html, new RegExp(`data-view="${view}"`));
  assert.match(html, /role="listbox"/);
  assert.match(html, /Changed files[\s\S]*Unavailable/);
  assert.match(html, /Commit messages[\s\S]*Unavailable/);
  assert.match(html, /Activity and history[\s\S]*Unavailable/);
});

test("Given narrow report viewports, when evidence and topology overflow, then each surface keeps a bounded local scroll region", () => {
  // Then
  assert.match(REPORT_CSS, /@media \(max-width: 900px\)/);
  assert.match(REPORT_CSS, /\.table-shell \{ max-height: 32rem; overflow: auto; border: 0; background: transparent; overscroll-behavior: contain;/);
  assert.match(REPORT_CSS, /#panel-evidence \{ min-width: 0; \}/);
  assert.match(REPORT_CSS, /#panel-evidence \.table-shell \{ max-width: 100%; max-height: 32rem; overflow: auto; overscroll-behavior: contain;/);
  assert.match(REPORT_CSS, /\.topology-stage-terminal \{ max-height: 32rem; overflow: auto;/);
  assert.match(REPORT_CSS, /\.topology-card, #topology-mode-selector, \.topology-stage, \.topology-alternative \{ min-width: 0; max-width: 100%; \}/);
  assert.match(REPORT_CSS, /\.topology-alternative \{[^}]*max-height: 32rem;[^}]*overflow: auto;[^}]*overscroll-behavior-inline: contain;/);
  assert.match(REPORT_CSS, /\.topology-stage \{ min-width: 0; min-height: 21rem; max-height: 32rem; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;/);
  assert.match(REPORT_CSS, /\.topology-stage \.topology-drawing \{ min-width: 50rem; width: 50rem; \}/);
  assert.match(REPORT_CSS, /\.topology-graphic \{ min-width: 0; max-width: 100%; width: 100%; overflow: hidden;/);
  assert.match(REPORT_CSS, /@media \(max-width: 420px\) \{ \.topology-stage \{ min-height: 0; \}/);
  assert.match(REPORT_CSS, /#topology-mode-selector button \{ flex: 0 0 auto; scroll-margin-inline: var\(--space-2\); white-space: nowrap;/);
  assert.match(REPORT_CSS, /#topology-mode-selector button, \.topology-controls button, \.topology-alternative summary, \.topology-graphic summary \{ min-height: 2\.75rem;/);
  assert.match(REPORT_CSS, /\.operations-filters, \.operations-view-toggle \{ width: 100%; flex-wrap: nowrap; overflow-x: auto;/);
  assert.match(REPORT_CSS, /\.operations-row \{ grid-template-columns: 1fr auto; min-height: 2\.75rem;/);
});

test("Given the dashboard controller, when reviewing interaction and safety contracts, then it remains selection-synchronized and read-only", () => {
  // Then
  for (const token of ["role", "group", "button", "aria-pressed", "operations-option-", "ArrowUp", "ArrowDown", "Home", "End", "Enter", "typeAhead", "operations-search", "base-distance", "Unverified relationship", "Unavailable", "replaceChildren", "createElementNS", "textContent", "setAttribute", "append"]) assert.match(OPERATIONS_CENTER_CONTROLLER, new RegExp(token));
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "Function(", "fetch(", "XMLHttpRequest", "WebSocket", "import(", "git ", "Fetched", "Pulled", "Removed", "Opened"]) assert.doesNotMatch(OPERATIONS_CENTER_CONTROLLER, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Given a rerendered inspector, when selection, guidance, and copy actions repeat, then visible guidance stays scoped to the current worktree", async () => {
  // Given
  const { document, copied } = runtime();
  const rowA = document.getElementById("operations-option-a");
  assert.ok(rowA);

  // When
  rowA.dispatch(new RuntimeEvent("click", rowA));
  const actionA = document.query("[data-action]").find((button) => button.getAttribute("data-action") === "switch");
  assert.ok(actionA);
  document.dispatch(new RuntimeEvent("click", actionA));
  const copyA = document.getElementById("guidance-copy");
  assert.ok(copyA);
  document.dispatch(new RuntimeEvent("click", copyA));
  await Promise.resolve();
  const rowB = document.getElementById("operations-option-b");
  assert.ok(rowB);
  rowB.dispatch(new RuntimeEvent("click", rowB));

  // Then
  assert.match(document.getElementById("operations-inspector-content")?.textContent ?? "", /guardian\/b/);
  assert.deepEqual(copied, ["Selected path: /repo/a. Open an OpenCode session at that path, then use guardian_status. This report does not switch worktrees."]);
  const actionB = document.query("[data-action]").find((button) => button.getAttribute("data-action") === "switch");
  assert.ok(actionB);
  document.dispatch(new RuntimeEvent("click", actionB));
  const copyB = document.getElementById("guidance-copy");
  assert.ok(copyB);
  document.dispatch(new RuntimeEvent("click", copyB));
  await Promise.resolve();
  assert.match(document.getElementById("guidance-text")?.textContent ?? "", /Selected path: \/repo\/b/);
  assert.equal(document.getElementById("guidance-copy-status")?.textContent, "Guidance copied.");
  assert.deepEqual(copied, ["Selected path: /repo/a. Open an OpenCode session at that path, then use guardian_status. This report does not switch worktrees.", "Selected path: /repo/b. Open an OpenCode session at that path, then use guardian_status. This report does not switch worktrees."]);
});

test("Given a selected row becomes filtered out, when rendering an empty result, then the listbox keeps selection without a detached active descendant", () => {
  // Given
  const { document } = runtime();
  const search = document.getElementById("operations-search");
  assert.ok(search);

  // When
  search.value = "no matching worktree";
  search.dispatch(new RuntimeEvent("input", search));

  // Then
  assert.equal(document.getElementById("operations-list")?.getAttribute("role"), "listbox");
  assert.equal(document.getElementById("operations-list")?.getAttribute("aria-activedescendant"), null);
});

test("Given timestamped observed events, when selecting Timeline or Swimlanes, then every event is rendered and Terminal has one alternative", () => {
  // Given
  const events = [
    { kind: "created", sessionId: "ses_a", at: "2026-08-13T12:00:00.000Z", action: null },
    { kind: "updated", sessionId: "ses_b", at: "2026-08-13T12:01:00.000Z", action: null },
  ];
  const { document } = runtime(events);

  // When
  for (const mode of ["timeline", "swimlanes"]) {
    const control = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === mode);
    assert.ok(control);
    control.dispatch(new RuntimeEvent("click", control));
    const renderedEvents = document.query("[data-topology-event]");

    // Then
    assert.equal(renderedEvents.length, events.length);
    for (const event of events) {
      assert.ok(renderedEvents.some((item) => item.textContent.includes(event.at)));
      assert.ok(renderedEvents.some((item) => item.getAttribute("class") === "topology-event-marker"));
    }
    assert.match(document.getElementById("topology-stage")?.textContent ?? "", /W1.*12:00.*created/);
  }

  const terminal = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "terminal");
  assert.ok(terminal);
  terminal.dispatch(new RuntimeEvent("click", terminal));

  // Then
  assert.equal(document.query("[data-topology-worktree]").length, 2);
  assert.match(document.getElementById("topology-stage")?.textContent ?? "", /State.*Branch.*Path.*HEAD.*Owner\/activity.*Action/);
});

test("Given dense timestamped events, when rendering Timeline, then every marker stays on an observed-worktree row", () => {
  // Given
  const events = Array.from({ length: 12 }, (_, index) => ({ kind: `event-${index}`, sessionId: index % 2 === 0 ? "ses_a" : "ses_b", at: `2026-08-13T12:${String(index).padStart(2, "0")}:00.000Z`, action: null }));
  const { document } = runtime(events);
  const timeline = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "timeline");
  assert.ok(timeline);

  // When
  timeline.dispatch(new RuntimeEvent("click", timeline));

  // Then
  assert.equal(document.query("[data-topology-event]").length, events.length);
  assert.equal(document.query("[class]").filter((element) => element.getAttribute("class") === "topology-timeline-row-bg").length, 2);
  for (const event of events) assert.ok(document.query("[data-topology-event]").some((element) => element.textContent.includes(event.at)));
});

test("Given a pan-capable topology mode, when dragging, zooming, and resetting, then viewport state persists and non-pan modes stay static", () => {
  // Given
  const { document } = runtime();
  const stage = document.getElementById("topology-stage");
  assert.ok(stage);

  // When
  stage.dispatch(new RuntimeEvent("pointerdown", stage, "", 0, 10, 10));
  stage.dispatch(new RuntimeEvent("pointermove", stage, "", 0, 30, 20));
  const draggedStage = document.getElementById("topology-stage");
  assert.ok(draggedStage);
  draggedStage.dispatch(new RuntimeEvent("pointermove", draggedStage, "", 0, 50, 40));
  const movedTransform = document.getElementById("topology-viewport")?.getAttribute("transform");
  const zoomIn = document.getElementById("topology-zoom-in");
  assert.ok(zoomIn);
  zoomIn.dispatch(new RuntimeEvent("click", zoomIn));
  const zoomedTransform = document.getElementById("topology-viewport")?.getAttribute("transform");
  const focusedZoom = document.activeElement?.id;
  const reset = document.getElementById("topology-reset");
  assert.ok(reset);
  reset.dispatch(new RuntimeEvent("click", reset));
  const radar = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "radar");
  assert.ok(radar);
  radar.dispatch(new RuntimeEvent("click", radar));
  const radarStage = document.getElementById("topology-stage");
  assert.ok(radarStage);
  const staticTransform = document.getElementById("topology-viewport")?.getAttribute("transform");
  radarStage.dispatch(new RuntimeEvent("wheel", radarStage, "", -1));

  // Then
  assert.match(movedTransform ?? "", /translate\(40,30\)/);
  assert.notEqual(zoomedTransform, movedTransform);
  assert.equal(focusedZoom, "topology-zoom-in");
  assert.equal(document.getElementById("topology-viewport")?.getAttribute("transform"), staticTransform);
  assert.equal(document.getElementById("topology-zoom-in"), null);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /pointerdown/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /Unverified relationship/);
});

test("Given topology modes and nodes, when using keyboard navigation or selecting a topology item, then the mode and worktree selection synchronize", () => {
  // Given
  const { document } = runtime();
  const metro = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "metro");
  assert.ok(metro);

  // When
  metro.dispatch(new RuntimeEvent("keydown", metro, "ArrowRight"));
  const nodeB = document.getElementById("topology-option-b");
  assert.ok(nodeB);
  nodeB.dispatch(new RuntimeEvent("click", nodeB));

  // Then
  const activeMode = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "radar");
  assert.equal(activeMode?.getAttribute("aria-checked"), "true");
  assert.equal(document.query("[data-topology-mode]").length, 7);
  assert.equal(activeMode?.getAttribute("tabindex"), "0");
  assert.equal(activeMode?.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement?.id, "topology-option-b");
  assert.equal(document.getElementById("operations-option-b")?.getAttribute("aria-selected"), "true");
  assert.match(OPERATIONS_CENTER_CONTROLLER, /topology-node .* selected/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /Selected .* at/);
  assert.match(REPORT_CSS, /#topology-mode-selector button\[aria-checked="true"\] \{ border-color: var\(--border\); color: var\(--fg\); background: var\(--surface-raised\); \}/);
});

test("Given focusable operation rows, when keyboard selection rerenders the dashboard, then the listbox owns focus and exposes the selected option", () => {
  // Given
  const { document } = runtime();
  const list = document.getElementById("operations-list");
  assert.ok(list);

  // When
  list.dispatch(new RuntimeEvent("keydown", list, "ArrowDown"));

  // Then
  assert.equal(list.getAttribute("role"), "listbox");
  assert.equal(list.getAttribute("aria-activedescendant"), "operations-option-b");
  assert.equal(document.getElementById("operations-option-b")?.getAttribute("role"), "option");
  assert.equal(document.getElementById("operations-option-b")?.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement?.id, "operations-list");
});

test("Given filters exclude the primary worktree, when viewing the graph, then complete context and unverified edges remain visible", () => {
  // Given
  const { document } = runtime();
  const terminal = document.query("[data-filter]").find((button) => button.getAttribute("data-filter") === "terminal");
  const graph = document.query("[data-view]").find((button) => button.getAttribute("data-view") === "graph");
  assert.ok(terminal);
  assert.ok(graph);

  // When
  terminal.dispatch(new RuntimeEvent("click", terminal));
  graph.dispatch(new RuntimeEvent("click", graph));

  // Then
  assert.equal(document.getElementById("operations-option-a"), null);
  assert.ok(document.getElementById("operations-graph-option-a"));
  assert.ok(document.getElementById("operations-graph-option-b"));
  assert.equal(document.query("[class]").filter((element) => element.getAttribute("class") === "operations-graph-edge").length, 1);
});

test("Given dense Swimlanes, when rendering five or twenty-five observed worktrees, then SVG bounds contain every lane and its limitation text", () => {
  for (const worktreeCount of [5, 25]) {
    // Given
    const { document } = runtime([], worktreeCount);
    const swimlanes = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "swimlanes");
    assert.ok(swimlanes);

    // When
    swimlanes.dispatch(new RuntimeEvent("click", swimlanes));

    // Then
    assert.equal(document.query("[class]").filter((element) => element.getAttribute("class") === "topology-swimlane").length, worktreeCount);
    const drawing = document.query("[role]").find((element) => element.getAttribute("role") === "group" && element.getAttribute("aria-label")?.startsWith("swimlanes"));
    assert.ok(drawing);
    assert.match(drawing.getAttribute("viewBox") ?? "", new RegExp(`0 0 800 ${Math.max(720, (worktreeCount * 90) + 150)}`));
    assert.match(document.getElementById("topology-stage")?.textContent ?? "", /Unavailable: no timestamped observed events/);
  }
});

test("Given a dense GitTree, when rendering twenty-five observed worktrees, then its rows remain inside data-dependent SVG bounds", () => {
  // Given
  const { document } = runtime([], 25);
  const gitTree = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "gittree");
  assert.ok(gitTree);

  // When
  gitTree.dispatch(new RuntimeEvent("click", gitTree));

  // Then
  const drawing = document.query("[role]").find((element) => element.getAttribute("role") === "group" && element.getAttribute("aria-label")?.startsWith("gittree"));
  assert.ok(drawing);
  assert.match(drawing.getAttribute("viewBox") ?? "", /0 0 800 1020/);
  assert.equal(document.query("[role]").filter((element) => element.id.startsWith("topology-option-") && element.getAttribute("role") === "button").length, 25);
});

test("Given topology text records and copy guidance, when rendered and copied, then labels and live feedback preserve the instruction text", async () => {
  // Given
  const { document } = runtime();
  const terminal = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "terminal");
  assert.ok(terminal);

  // When
  terminal.dispatch(new RuntimeEvent("click", terminal));
  const copy = document.getElementById("guidance-copy");
  assert.ok(copy);
  document.dispatch(new RuntimeEvent("click", copy));
  await Promise.resolve();

  // Then
  assert.equal(document.query("[data-topology-worktree]").length, 2);
  assert.match(document.getElementById("topology-stage")?.textContent ?? "", /State.*Branch.*Path.*HEAD.*Owner\/activity.*Action/);
  assert.equal(document.getElementById("guidance-text")?.textContent.includes("Copied."), false);
  assert.equal(document.getElementById("guidance-copy-status")?.getAttribute("aria-live"), "polite");
});

test("Given every visual topology mode, when selected, then its evidence-safe visual grammar uses a distinct structural primitive and one discoverable terminal alternative", () => {
  // Given
  const { document } = runtime([{ kind: "created", sessionId: "ses_a", at: "2026-08-13T12:00:00.000Z", action: null }]);

  // When
  const expectedClass = new Map([["metro", "topology-metro-trunk"], ["radar", "topology-radar-ring"], ["timeline", "topology-timeline-axis"], ["gittree", "topology-gittree-root"], ["sunburst", "topology-sunburst-sector"], ["swimlanes", "topology-swimlane"]]);
  const results = [...expectedClass].map(([mode, className]) => {
    const control = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === mode);
    assert.ok(control);
    control.dispatch(new RuntimeEvent("click", control));
    return { className, primitive: OPERATIONS_CENTER_CONTROLLER.includes(className), alternatives: document.query("[data-topology-alternative]").length };
  });

  // Then
  for (const result of results) {
    assert.equal(result.primitive, true);
    assert.equal(result.alternatives, 1);
  }
});

test("Given dense observed worktree names, when rendering topology visuals, then concise indexed labels keep full names in accessible records", () => {
  // Given
  const { document } = runtime([], 25);

  // When
  const metro = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "metro");
  assert.ok(metro);
  metro.dispatch(new RuntimeEvent("click", metro));

  // Then
  assert.match(OPERATIONS_CENTER_CONTROLLER, /topologyVisualLabel/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /const topologyNode = \(viewport, items, worktree, x, y, labelOffset = 0, maxLabels = 12\)/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /const labelEvery = Math\.max\(1, Math\.ceil\(items\.length \/ maxLabels\)\)/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /const showLabel = labelIndex % labelEvery === 0/);
  assert.match(document.getElementById("topology-stage")?.textContent ?? "", /W1/);
  assert.match(document.getElementById("topology-stage")?.textContent ?? "", /W25/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /aria-label.*select observed worktree/);
  assert.doesNotMatch(OPERATIONS_CENTER_CONTROLLER, /label\(item\)\.replace\("guardian\//);
});

test("Given dense radial topologies, when rendering radar and sunburst, then short labels are capped while every node remains focusable and named", () => {
  // Given
  const { document } = runtime([], 25);

  // When
  for (const mode of ["radar", "sunburst"]) {
    const control = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === mode);
    assert.ok(control);
    control.dispatch(new RuntimeEvent("click", control));
    const nodes = document.query("[role]").filter((element) => element.id.startsWith("topology-option-") && element.getAttribute("role") === "button");
    const labels = nodes.filter((node) => /^W\d+$/.test(node.textContent));

    // Then
    assert.equal(nodes.length, 25);
    assert.ok(labels.length <= 8);
    for (const node of nodes) assert.match(node.getAttribute("aria-label") ?? "", /guardian\/.*select observed worktree/);
    if (mode === "radar") {
      assert.equal(document.query("[class]").filter((element) => element.getAttribute("class") === "topology-radar-ring").length, 5);
      assert.equal(document.query("[class]").filter((element) => element.getAttribute("class") === "topology-radar-axis").length, 6);
    } else {
      assert.equal(document.query("[class]").filter((element) => element.getAttribute("class")?.startsWith("topology-sunburst-sector ")).length, 24);
      assert.equal(document.query("[class]").filter((element) => element.getAttribute("class") === "topology-sunburst-ring").length, 4);
    }
  }
});

test("Given the Metro topology, when rendering observed worktrees, then the trunk, curved branch, station, and lifecycle pill remain distinct", () => {
  // Given
  const { document } = runtime();
  const metro = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "metro");
  assert.ok(metro);

  // When
  metro.dispatch(new RuntimeEvent("click", metro));

  // Then
  const trunk = document.query("[class]").find((element) => element.getAttribute("class") === "topology-metro-trunk");
  const branch = document.query("[class]").find((element) => element.getAttribute("class")?.startsWith("topology-metro-branch "));
  assert.equal(trunk?.getAttribute("y1"), "360");
  assert.equal(trunk?.getAttribute("y2"), "360");
  assert.match(branch?.getAttribute("d") ?? "", /^M.*C/);
  assert.equal(document.query("[class]").filter((element) => element.getAttribute("class")?.startsWith("topology-metro-station ")).length, 1);
  assert.equal(document.query("[class]").filter((element) => element.getAttribute("class")?.startsWith("topology-lifecycle-pill ")).length, 1);
});

test("Given unordered, repeated, unmatched, and unavailable observed events, when rendering topology modes, then event facts, selection, and keyboard pan remain complete", () => {
  // Given
  const events = [
    { kind: "later", sessionId: "ses_a", at: "2026-08-13T12:02:00.000Z", action: null },
    { kind: "unmatched", sessionId: "ses_missing", at: "2026-08-13T12:01:00.000Z", action: null },
    { kind: "earlier", sessionId: "ses_a", at: "2026-08-13T12:00:00.000Z", action: null },
    { kind: "unavailable", sessionId: "ses_b", at: null, action: null },
  ];
  const { document } = runtime(events);
  const timeline = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "timeline");
  assert.ok(timeline);

  // When
  timeline.dispatch(new RuntimeEvent("click", timeline));
  const stage = document.getElementById("topology-stage");
  assert.ok(stage);
  stage.dispatch(new RuntimeEvent("keydown", stage, "ArrowRight"));
  const panned = document.getElementById("topology-viewport")?.getAttribute("transform");
  stage.dispatch(new RuntimeEvent("keydown", stage, "Home"));
  const reset = document.getElementById("topology-viewport")?.getAttribute("transform");
  const terminal = document.query("[data-topology-mode]").find((button) => button.getAttribute("data-topology-mode") === "terminal");
  assert.ok(terminal);
  terminal.dispatch(new RuntimeEvent("click", terminal));
  const selectA = document.getElementById("topology-terminal-option-a");
  assert.ok(selectA);
  selectA.dispatch(new RuntimeEvent("click", selectA));

  // Then
  assert.match(document.getElementById("topology-stage")?.textContent ?? "", /Session.*Kind.*Timestamp.*Action\/availability.*ses_missing.*Unavailable/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /Only observed timestamps are positioned; lifecycle intervals are never inferred/);
  assert.match(panned ?? "", /translate\(24,0\)/);
  assert.equal(reset, "translate(0,0) scale(1)");
  assert.equal(document.getElementById("topology-terminal-option-a")?.getAttribute("aria-pressed"), "true");
  assert.match(document.getElementById("topology-stage")?.textContent ?? "", /Selected/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /Show graphical .* view/);
  assert.match(OPERATIONS_CENTER_CONTROLLER, /matchMedia/);
});

test("Given dashboard tabs, when activating them by keyboard and click, then roving focus and matching panels remain synchronized", () => {
  // Given
  const { document } = runtime();
  const operations = document.getElementById("tab-operations");
  const topology = document.getElementById("tab-topology");
  assert.ok(operations);
  assert.ok(topology);

  // When
  const right = new RuntimeEvent("keydown", operations, "ArrowRight");
  operations.dispatch(right);
  const end = new RuntimeEvent("keydown", topology, "End");
  topology.dispatch(end);
  const raw = document.getElementById("tab-raw-data");
  assert.ok(raw);
  const home = new RuntimeEvent("keydown", raw, "Home");
  raw.dispatch(home);
  const evidence = document.getElementById("tab-evidence");
  assert.ok(evidence);
  evidence.dispatch(new RuntimeEvent("click", evidence));

  // Then
  assert.equal(right.defaultPrevented, true);
  assert.equal(end.defaultPrevented, true);
  assert.equal(home.defaultPrevented, true);
  assert.equal(document.activeElement?.id, "tab-evidence");
  assert.equal(evidence.getAttribute("aria-selected"), "true");
  assert.equal(evidence.getAttribute("tabindex"), "0");
  assert.equal(document.getElementById("panel-evidence")?.hidden, false);
  assert.equal(document.getElementById("panel-operations")?.hidden, true);
});

test("Given observed worktrees, when filtering, sorting, viewing, and navigating the list, then only matching live records are selected", () => {
  // Given
  const { document } = runtime();
  const active = document.query("[data-filter]").find((button) => button.getAttribute("data-filter") === "active");
  const terminal = document.query("[data-filter]").find((button) => button.getAttribute("data-filter") === "terminal");
  const graph = document.query("[data-view]").find((button) => button.getAttribute("data-view") === "graph");
  const list = document.getElementById("operations-list");
  const sort = document.getElementById("operations-sort");
  assert.ok(active);
  assert.ok(terminal);
  assert.ok(graph);
  assert.ok(list);
  assert.ok(sort);

  // When
  active.dispatch(new RuntimeEvent("click", active));
  sort.value = "base-distance";
  sort.dispatch(new RuntimeEvent("change", sort));
  const end = new RuntimeEvent("keydown", list, "End");
  list.dispatch(end);
  terminal.dispatch(new RuntimeEvent("click", terminal));
  const terminalRow = document.getElementById("operations-option-b");
  assert.ok(terminalRow);
  terminalRow.dispatch(new RuntimeEvent("click", terminalRow));
  graph.dispatch(new RuntimeEvent("click", graph));

  // Then
  assert.equal(document.query("[data-filter]").find((button) => button.getAttribute("data-filter") === "active")?.getAttribute("aria-pressed"), "false");
  assert.equal(end.defaultPrevented, true);
  assert.equal(document.query("[data-filter]").find((button) => button.getAttribute("data-filter") === "terminal")?.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("operations-option-a"), null);
  assert.equal(document.getElementById("operations-option-b")?.getAttribute("aria-selected"), "true");
  assert.equal(list.hidden, true);
  assert.equal(document.getElementById("operations-graph")?.hidden, false);
  assert.ok(document.getElementById("operations-graph-option-a"));
  assert.ok(document.getElementById("operations-graph-option-b"));
});

test("Given a graph and global shortcut, when selecting with graph keys and list typeahead, then selection and focus are retained through rerenders", () => {
  // Given
  const { document } = runtime();
  const graphView = document.query("[data-view]").find((button) => button.getAttribute("data-view") === "graph");
  assert.ok(graphView);
  graphView.dispatch(new RuntimeEvent("click", graphView));
  const graphNode = document.getElementById("operations-graph-option-b");
  assert.ok(graphNode);

  // When
  const enter = new RuntimeEvent("keydown", graphNode, "Enter");
  graphNode.dispatch(enter);
  const list = document.getElementById("operations-list");
  assert.ok(list);
  list.dispatch(new RuntimeEvent("keydown", list, "g"));
  const shortcut = new RuntimeEvent("keydown", list, "/");
  document.dispatch(shortcut);

  // Then
  assert.equal(enter.defaultPrevented, true);
  assert.equal(document.getElementById("operations-option-a")?.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement?.id, "operations-search");
  assert.equal(shortcut.defaultPrevented, true);
  assert.match(document.getElementById("operations-inspector-content")?.textContent ?? "", /guardian\/a/);
});

test("Given a pan-capable topology, when cancelling a drag and using keyboard pan controls, then only active gestures change the bounded viewport", () => {
  // Given
  const { document } = runtime();
  const stage = document.getElementById("topology-stage");
  assert.ok(stage);

  // When
  stage.dispatch(new RuntimeEvent("pointerdown", stage, "", 0, 10, 10));
  stage.dispatch(new RuntimeEvent("pointermove", stage, "", 0, 40, 30));
  stage.dispatch(new RuntimeEvent("pointercancel", stage));
  const cancelled = document.getElementById("topology-viewport")?.getAttribute("transform");
  stage.dispatch(new RuntimeEvent("pointermove", stage, "", 0, 80, 80));
  const left = new RuntimeEvent("keydown", stage, "ArrowLeft");
  stage.dispatch(left);
  const reset = new RuntimeEvent("keydown", stage, "0");
  stage.dispatch(reset);

  // Then
  assert.match(cancelled ?? "", /translate\(30,20\)/);
  assert.equal(left.defaultPrevented, true);
  assert.equal(reset.defaultPrevented, true);
  assert.equal(document.getElementById("topology-viewport")?.getAttribute("transform"), "translate(0,0) scale(1)");
});
