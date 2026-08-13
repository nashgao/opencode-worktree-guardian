import { TOPOLOGY_CONTROLLER_FRAGMENT } from "./topology-controller.ts";

export const OPERATIONS_CENTER_CONTROLLER = `(() => {
  const source = document.getElementById("guardian-report-data");
  if (!source) return;
  const payload = JSON.parse(source.textContent || "{}");
  const model = payload.model || {};
  const worktrees = Array.isArray(model.worktrees) ? model.worktrees : [];
  const tabs = Array.from(document.querySelectorAll("[role=tab]"));
  const panels = Array.from(document.querySelectorAll("[role=tabpanel]"));
  const list = document.getElementById("operations-list");
  const graph = document.getElementById("operations-graph");
  const graphSvg = document.getElementById("operations-graph-svg");
  const inspector = document.getElementById("operations-inspector-content");
  const search = document.getElementById("operations-search");
  const sort = document.getElementById("operations-sort");
  const raw = document.getElementById("raw-json");
  if (!list || !graph || !graphSvg || !inspector || !search || !sort || !raw) return;
  const filters = Array.from(document.querySelectorAll("[data-filter]"));
  const views = Array.from(document.querySelectorAll("[data-view]"));
  const selectionById = new Map((payload.guidance.worktrees || []).map((entry) => [entry.worktreeId, entry]));
  let filter = "all";
  let view = "list";
  let selectedId = worktrees[0] ? worktrees[0].id : null;
  let guidanceState = { title: "Select an operation", text: "Guidance remains selectable and no action is executed from this report." };
  let typeAhead = "";
  let typeAheadTimer = 0;
  const optionId = (id) => "operations-option-" + id;
  const label = (worktree) => worktree.branch || (worktree.flags.detached ? "detached" : "unborn branch");
  const selected = () => worktrees.find((worktree) => worktree.id === selectedId) || null;
  const selection = () => selectionById.get(selectedId) || payload.guidance.fallback;
  const risk = (worktree) => worktree.risk.external || worktree.risk.orphaned || worktree.risk.poisoned;
  const matchesFilter = (worktree) => filter === "all" || (filter === "active" && worktree.state === "active") || (filter === "terminal" && worktree.state === "terminal") || (filter === "risk" && risk(worktree)) || (filter === "unmanaged" && worktree.state === "unmanaged");
  const matchesSearch = (worktree) => {
    const owner = worktree.owner.sessionId || "";
    const value = [label(worktree), worktree.path, worktree.state, owner].join(" ").toLowerCase();
    return value.includes(search.value.toLowerCase());
  };
  const distance = (worktree) => worktree.baseDistance.status === "available" ? worktree.baseDistance.ahead + worktree.baseDistance.behind : Number.MAX_SAFE_INTEGER;
  const ordered = () => worktrees.filter((worktree) => matchesFilter(worktree) && matchesSearch(worktree)).sort((left, right) => {
    const field = sort.value;
    const leftValue = field === "path" ? left.path : field === "state" ? left.state : field === "base-distance" ? String(distance(left)).padStart(16, "0") : label(left);
    const rightValue = field === "path" ? right.path : field === "state" ? right.state : field === "base-distance" ? String(distance(right)).padStart(16, "0") : label(right);
    return leftValue.localeCompare(rightValue) || left.id.localeCompare(right.id);
  });
  const fact = (name, value) => { const section = document.createElement("section"); section.className = "operations-fact"; const heading = document.createElement("h3"); heading.textContent = name; const content = document.createElement("p"); content.textContent = value; section.append(heading, content); return section; };
  const flagText = (worktree) => [worktree.flags.primary ? "primary" : "", worktree.flags.linked ? "linked" : "", worktree.flags.detached ? "detached" : "", worktree.flags.bare ? "bare" : ""].filter(Boolean).join(", ") || "none";
  const baseText = (worktree) => worktree.baseDistance.status === "available" ? worktree.baseDistance.baseRef + " | " + worktree.baseDistance.relation + " | ahead " + worktree.baseDistance.ahead + " | behind " + worktree.baseDistance.behind : "Unavailable: " + worktree.baseDistance.reason;
  const riskText = (worktree) => { const flags = [worktree.risk.external ? "external" : "", worktree.risk.orphaned ? "orphaned" : "", worktree.risk.poisoned ? "poisoned" : ""].filter(Boolean); return flags.length ? flags.join(", ") : "none observed"; };
  const updateGuidance = (action) => { const result = selection().actions.find((entry) => entry.id === action); if (result) { guidanceState = { title: result.title, text: result.instruction }; renderInspector(); document.querySelector("[data-action=" + action + "]")?.focus(); } };
  const renderInspector = () => {
    const worktree = selected();
    inspector.replaceChildren();
    const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "Selected worktree";
    const heading = document.createElement("h2"); heading.textContent = worktree ? label(worktree) : "Selection unavailable";
    inspector.append(eyebrow, heading);
    if (worktree) {
      inspector.append(fact("Path", worktree.path), fact("Head", worktree.head || "Unavailable"), fact("State", worktree.state + " | " + worktree.tone), fact("Owner session", worktree.owner.sessionId || "Unavailable"), fact("Owner status", worktree.owner.status || "Unavailable"), fact("Worktree flags", flagText(worktree)), fact("Base distance", baseText(worktree)), fact("Risk flags", riskText(worktree)));
    }
    inspector.append(fact("Changed files", "Unavailable. Guardian reports only repository-wide dirty-file inventory."), fact("Commit messages", "Unavailable. This report has no commit-message facts."), fact("Activity and history", "Unavailable. This dashboard does not infer lifecycle activity."));
    const guidancePanel = document.createElement("aside"); guidancePanel.className = "guidance"; guidancePanel.setAttribute("aria-labelledby", "guidance-title"); guidancePanel.setAttribute("aria-describedby", "guidance-text"); const guidanceHeading = document.createElement("h3"); guidanceHeading.id = "guidance-title"; guidanceHeading.textContent = guidanceState.title; const guidanceText = document.createElement("p"); guidanceText.id = "guidance-text"; guidanceText.textContent = guidanceState.text; const copyButton = document.createElement("button"); copyButton.id = "guidance-copy"; copyButton.type = "button"; copyButton.textContent = "Copy guidance"; const copyStatus = document.createElement("p"); copyStatus.id = "guidance-copy-status"; copyStatus.className = "visually-hidden"; copyStatus.setAttribute("aria-live", "polite"); guidancePanel.append(guidanceHeading, guidanceText, copyButton, copyStatus);
    const actionGrid = document.createElement("div"); actionGrid.className = "action-grid"; (model.actions || []).forEach((action) => { const button = document.createElement("button"); button.type = "button"; button.className = "action-button"; button.setAttribute("data-action", action.id); button.textContent = action.id; actionGrid.append(button); });
    inspector.append(guidancePanel, actionGrid);
  };
  const choose = (id, focusId) => { selectedId = id; guidanceState = { title: "Select an operation", text: "Guidance remains selectable and no action is executed from this report." }; render(); renderInspector(); renderTopology(); if (focusId) document.getElementById(focusId)?.focus(); };
  const renderList = (items) => {
    list.replaceChildren();
    const selectedVisible = items.find((worktree) => worktree.id === selectedId);
    if (selectedVisible) list.setAttribute("aria-activedescendant", optionId(selectedVisible.id)); else list.removeAttribute("aria-activedescendant");
    if (items.length === 0) { const empty = document.createElement("p"); empty.id = "operations-empty"; empty.textContent = "No observed worktrees match this view."; list.append(empty); return; }
    items.forEach((worktree) => { const row = document.createElement("div"); row.id = optionId(worktree.id); row.className = "operations-row"; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(worktree.id === selectedId)); const branch = document.createElement("strong"); branch.textContent = label(worktree); const path = document.createElement("span"); path.className = "operations-row-path"; path.textContent = worktree.path; const state = document.createElement("span"); state.className = "operations-state " + worktree.tone; state.textContent = worktree.state; const owner = document.createElement("span"); owner.className = "operations-row-owner"; owner.textContent = worktree.owner.sessionId || "unmanaged"; row.append(branch, path, state, owner); row.addEventListener("click", () => choose(worktree.id, "operations-list")); list.append(row); });
  };
  list.setAttribute("role", "listbox"); list.setAttribute("tabindex", "0"); list.setAttribute("aria-label", "Observed worktrees");
  const svg = (name) => document.createElementNS("http:" + "//www.w3.org/2000/svg", name);
  const renderGraph = () => {
    graphSvg.replaceChildren();
    const items = worktrees; const primary = items.find((worktree) => worktree.flags.primary);
    if (!primary) return;
    const center = { x: 400, y: 210 }; const others = items.filter((worktree) => worktree.id !== primary.id);
    const positions = new Map([[primary.id, center]]);
    others.forEach((worktree, index) => { const angle = (index / Math.max(others.length, 1)) * Math.PI * 2 - Math.PI / 2; positions.set(worktree.id, { x: center.x + Math.cos(angle) * 150, y: center.y + Math.sin(angle) * 150 }); });
    graphSvg.setAttribute("role", "group"); graphSvg.setAttribute("aria-label", "Observed worktree graph. Relationships are unverified.");
    (model.topology.edges || []).forEach((edge) => { const from = positions.get(edge.from); const to = positions.get(edge.to); if (!from || !to) return; const line = svg("line"); line.setAttribute("class", "operations-graph-edge"); line.setAttribute("x1", String(from.x)); line.setAttribute("y1", String(from.y)); line.setAttribute("x2", String(to.x)); line.setAttribute("y2", String(to.y)); line.setAttribute("aria-label", edge.label || "Unverified relationship"); graphSvg.append(line); });
    items.forEach((worktree) => { const position = positions.get(worktree.id); if (!position) return; const node = svg("g"); node.id = "operations-graph-option-" + worktree.id; node.setAttribute("role", "button"); node.setAttribute("tabindex", "0"); node.setAttribute("aria-pressed", String(worktree.id === selectedId)); node.setAttribute("aria-label", label(worktree) + ", select observed worktree"); node.setAttribute("class", "operations-graph-node " + (worktree.id === selectedId ? "selected" : "")); const circle = svg("circle"); circle.setAttribute("cx", String(position.x)); circle.setAttribute("cy", String(position.y)); circle.setAttribute("r", worktree.flags.primary ? "32" : "25"); const text = svg("text"); text.setAttribute("x", String(position.x)); text.setAttribute("y", String(position.y + 4)); text.setAttribute("text-anchor", "middle"); text.textContent = label(worktree); node.append(circle, text); node.addEventListener("click", () => choose(worktree.id, node.id)); node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(worktree.id, node.id); } }); graphSvg.append(node); });
  };
  const updateCounts = () => filters.forEach((button) => { const key = button.getAttribute("data-filter"); const count = key === "all" ? worktrees.length : worktrees.filter((worktree) => key === "active" ? worktree.state === "active" : key === "terminal" ? worktree.state === "terminal" : key === "risk" ? risk(worktree) : worktree.state === "unmanaged").length; const display = button.querySelector("[data-filter-count]"); if (display) display.textContent = String(count); });
  const render = () => { const items = ordered(); renderList(items); renderGraph(); filters.forEach((button) => { const active = button.getAttribute("data-filter") === filter; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); }); views.forEach((button) => { const active = button.getAttribute("data-view") === view; button.setAttribute("aria-pressed", String(active)); }); list.hidden = view !== "list"; graph.hidden = view !== "graph"; updateCounts(); };
  const activate = (tab) => { const target = tab.getAttribute("aria-controls"); tabs.forEach((item) => { const active = item === tab; item.setAttribute("aria-selected", String(active)); item.setAttribute("tabindex", active ? "0" : "-1"); }); panels.forEach((panel) => { panel.hidden = panel.id !== target; }); tab.focus(); };
  const moveTab = (tab, offset) => { const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length]; next.focus(); activate(next); };
  tabs.forEach((tab) => tab.addEventListener("keydown", (event) => { if (event.key === "ArrowRight") { event.preventDefault(); moveTab(tab, 1); } if (event.key === "ArrowLeft") { event.preventDefault(); moveTab(tab, -1); } if (event.key === "Home") { event.preventDefault(); tabs[0].focus(); activate(tabs[0]); } if (event.key === "End") { event.preventDefault(); tabs[tabs.length - 1].focus(); activate(tabs[tabs.length - 1]); } if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(tab); } }));
  tabs.forEach((tab) => tab.addEventListener("click", () => activate(tab)));
  filters.forEach((button) => button.addEventListener("click", () => { filter = button.getAttribute("data-filter") || "all"; render(); }));
  views.forEach((button) => button.addEventListener("click", () => { view = button.getAttribute("data-view") || "list"; render(); }));
  search.addEventListener("input", render); sort.addEventListener("change", render);
  list.addEventListener("keydown", (event) => { const items = ordered(); const index = items.findIndex((worktree) => worktree.id === selectedId); const next = event.key === "ArrowDown" ? items[Math.min(index + 1, items.length - 1)] : event.key === "ArrowUp" ? items[Math.max(index, 1) - 1] : event.key === "Home" ? items[0] : event.key === "End" ? items[items.length - 1] : null; if (next) { event.preventDefault(); choose(next.id, "operations-list"); } if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (selectedId) choose(selectedId, "operations-list"); } if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) { typeAhead += event.key.toLowerCase(); window.clearTimeout(typeAheadTimer); typeAheadTimer = window.setTimeout(() => { typeAhead = ""; }, 500); const match = items.find((worktree) => label(worktree).toLowerCase().startsWith(typeAhead)); if (match) choose(match.id, "operations-list"); } });
  document.addEventListener("keydown", (event) => { if (event.key === "/" && document.activeElement !== search) { event.preventDefault(); search.focus(); } });
  document.addEventListener("click", (event) => { const target = event.target.closest("[data-action]"); if (target) updateGuidance(target.getAttribute("data-action")); const copyTarget = event.target.closest("#guidance-copy"); if (!copyTarget || !navigator.clipboard) return; navigator.clipboard.writeText(guidanceState.text).then(() => { const status = document.getElementById("guidance-copy-status"); if (status) status.textContent = "Guidance copied."; }, () => { const status = document.getElementById("guidance-copy-status"); if (status) status.textContent = "Copy unavailable."; }); });
${TOPOLOGY_CONTROLLER_FRAGMENT}
  raw.textContent = JSON.stringify(model.raw, null, 2);
  updateCounts(); render(); renderInspector(); renderTopology();
})();`;
