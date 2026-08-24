import type { GuardianRecoverResult, GuardianStatusResult } from "../status-result-types.ts";
import { canonicalPath, type GuardianVerdict } from "../verdict.ts";
import type { MutableRecord } from "../types.ts";
import { isMutableRecord } from "../types.ts";

type RecordValue = MutableRecord;
const record = (value: unknown): RecordValue => isMutableRecord(value) ? value : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, fallback = "-") => typeof value === "string" && value ? value : fallback;
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const escape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/=/g, "&#61;");
const short = (value: unknown) => text(value) === "-" ? "-" : text(value).slice(0, 12);
const empty = (columns: number, message: string) => `<tr><td colspan="${columns}" class="empty">${escape(message)}</td></tr>`;

function table(caption: string, headers: readonly string[], rows: string, className = "") {
  return `<div class="table-shell"><table class="${escape(className)}"><caption class="visually-hidden">${escape(caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${escape(header)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function sessions(entries: unknown[]) {
  const rows = entries.map((entry) => { const item = record(entry); return `<tr><td data-label="Session">${escape(item.session_id ?? item.sessionId)}</td><td data-label="Status">${escape(item.status)}</td><td data-label="Branch">${escape(item.branch)}</td><td data-label="Worktree">${escape(item.worktree_path ?? item.worktreePath)}</td><td data-label="Head">${escape(short(item.head_commit ?? item.headCommit))}</td></tr>`; }).join("") || empty(5, "No guardian sessions recorded.");
  return table("Guardian session inventory", ["Session", "Status", "Branch", "Worktree", "Head"], rows);
}

function worktrees(entries: unknown[]) {
  const rows = entries.map((entry) => { const item = record(entry); const markers = [item.detached === true ? "detached" : "", item.bare === true ? "bare" : ""].filter(Boolean).join(", "); return `<tr><td data-label="Branch">${escape(item.branch)}</td><td data-label="Path">${escape(item.path)}</td><td data-label="Head">${escape(short(item.head))}</td><td data-label="Markers">${escape(markers || "clean")}</td></tr>`; }).join("") || empty(4, "No git worktrees found.");
  return table("Git worktree inventory", ["Branch", "Path", "Head", "Markers"], rows);
}

function branches(entries: unknown[]) {
  const rows = entries.map((entry) => { const item = record(entry); return `<tr><td data-label="Branch Without Worktree">${escape(item.name ?? entry)}</td><td data-label="Commit">${escape(short(item.commit ?? item.head))}</td></tr>`; }).join("") || empty(2, "Every listed branch has a worktree.");
  return table("Branches without linked worktrees", ["Branch Without Worktree", "Commit"], rows);
}

function item(entry: unknown) {
  const value = record(entry); const path = value.path ?? value.worktree_path; const session = value.session_id ?? value.sessionId; const head = value.head ?? value.head_commit ?? value.commit; const reason = typeof value.reason === "string" ? ` — ${escape(value.reason)}` : ""; const subject = typeof value.subject === "string" ? ` — ${escape(value.subject)}` : "";
  if (value.kind === "reflog") return `Reflog <code>${escape(value.selector)}</code> at <code>${escape(value.commit)}</code>${subject}`;
  if (value.kind === "unreachable") return `Unreachable <code>${escape(value.commit)}</code>`;
  if (typeof value.name === "string" && typeof value.commit === "string") return `<code>${escape(value.name)}</code> at <code>${escape(value.commit)}</code>${subject}`;
  if (typeof path === "string" && typeof value.branch === "string") return `<code>${escape(path)}</code> on branch <code>${escape(value.branch)}</code>${typeof session === "string" ? ` for <code>${escape(session)}</code>` : ""}${reason}`;
  if (typeof path === "string" && typeof session === "string") return `<code>${escape(path)}</code> in <code>${escape(session)}</code>${reason}`;
  if (typeof value.ref === "string" && typeof head === "string") return `<code>${escape(value.ref)}</code> at <code>${escape(head)}</code>${reason}`;
  return `<code>${escape(text(value.ref ?? path ?? session ?? value.branch ?? value.name ?? entry, JSON.stringify(entry)))}</code>${reason}`;
}

function list(title: string, entries: unknown[], tone: "risk" | "info", message: string) {
  const id = `${title.toLowerCase().replaceAll(" ", "-")}-heading`;
  return `<section class="card ${tone} ${entries.length === 0 ? "empty-state" : ""}" aria-labelledby="${id}"><h2 id="${id}">${escape(title)}</h2><ul>${entries.map((entry) => `<li>${item(entry)}</li>`).join("") || `<li class="empty">${message}</li>`}</ul></section>`;
}

function hygiene(input: unknown) {
  const value = record(input); const summary = record(value.summary); const findings = array(value.findings); const candidates = array(value.reviewableCandidates); const bySeverity = record(summary.bySeverity); const byCategory = record(summary.byCategory); const count = number(summary.findingCount, findings.length);
  const metrics = [["Candidate Paths", number(summary.candidateCount)], ["Findings", count], ["Reviewable", number(summary.reviewableCandidateCount, candidates.length)], ["Manual Review", number(bySeverity.fail)], ["Warn", number(bySeverity.warn)], ["Known Cleanable", number(byCategory["known-cleanable"])], ["Nested Git", number(byCategory["nested-git"])], ["Suspicious", number(byCategory.suspicious)], ["Exclusions", number(summary.exclusionCount)]];
  const findingRows = [...findings].map((entry) => { const finding = record(entry); const level = text(finding.severity) === "fail" ? "manual review" : text(finding.severity); return `<tr><td data-label="Review Level"><span class="status-pill ${level === "manual review" || level === "warn" ? "warn" : ""}">${escape(level)}</span></td><td data-label="Category">${escape(finding.category)}</td><td data-label="Path"><code>${escape(finding.path)}</code></td><td data-label="Reason">${escape(finding.reason)}</td></tr>`; }).join("") || empty(4, "No workspace hygiene findings recorded.");
  const candidateRows = candidates.map((entry) => { const candidate = record(entry); return `<tr><td data-label="Status">${escape(candidate.status)}</td><td data-label="Path"><code>${escape(candidate.path)}</code></td><td data-label="Reason">${escape(candidate.reason)}</td><td data-label="Suggested Command"><code>${escape(candidate.suggestedDeletePathCommand)}</code></td></tr>`; }).join("") || empty(4, "No reviewable hygiene candidates recorded.");
  return `<section class="card hygiene ${count > 0 ? "warning" : "info"}" aria-labelledby="workspace-hygiene-heading"><h2 id="workspace-hygiene-heading">Workspace Hygiene</h2><p class="section-note">Report-only scan of untracked and ignored workspace artifacts. No cleanup actions are performed here.</p>${value.ok === false ? `<p class="hygiene-alert">Scan failed: ${escape(value.reason)}</p>` : ""}<div class="hygiene-metrics">${metrics.map(([label, metric]) => `<article class="hygiene-count"><span>${label}</span><strong>${metric}</strong></article>`).join("")}</div><h3>Top Findings By Review Level And Category</h3>${table("Top workspace hygiene findings", ["Review Level", "Category", "Path", "Reason"], findingRows, "hygiene-findings")}<h3>Reviewable Candidates</h3><p class="section-note">Plan exact deletes with guardian_delete_paths mode=plan after review. Showing ${number(summary.reviewableShownCount, candidates.length)} of ${number(summary.reviewableCandidateCount, candidates.length)}.</p>${table("Reviewable workspace hygiene candidates", ["Status", "Path", "Reason", "Suggested Command"], candidateRows, "reviewable-table")}</section>`;
}

function candidates(recover: GuardianRecoverResult): unknown[] {
  return [...recover.recoveryCandidates.reflog.map((entry) => ({ ...entry, kind: "reflog" })), ...recover.recoveryCandidates.unreachable.map((commit) => ({ commit, kind: "unreachable" }))];
}

function baseAuthority(status: GuardianStatusResult) {
  const authority = status.baseAuthority;
  const rows = authority.status === "available"
    ? [["State", authority.status], ["Base Ref", authority.baseRef], ["Authority Ref", authority.baseAuthorityRef], ["Base Commit", authority.baseRefOid], ["Effective Remote", authority.effectiveRemote], ["Source", authority.source]]
    : [["State", authority.status], ["Reason", authority.reason]];
  return `<section class="card half" aria-labelledby="base-authority-heading"><h2 id="base-authority-heading">Base Authority</h2><p class="section-note">Cached/read-only base authority observed when this report was generated.</p>${table("Cached base authority", ["Fact", "Value"], rows.map(([label, value]) => `<tr><th scope="row">${escape(label)}</th><td data-label="${escape(label)}"><code>${escape(value)}</code></td></tr>`).join(""), "base-authority-table")}</section>`;
}

function operationalScope(status: GuardianStatusResult) {
  const scope = status.operationalScope;
  const freshness = scope.freshness === "cached-read-only" ? "cached/read-only" : scope.freshness;
  const rows = [["Effective Remote", scope.effectiveRemote], ["Freshness", freshness], ["Local Branches", scope.localBranchCount], ["Effective Remote Branches", scope.effectiveRemoteBranchCount]];
  const remotes = scope.unexaminedSecondaryRemotes.map((remote) => `<li><code>${escape(remote)}</code></li>`).join("") || '<li class="empty">None reported.</li>';
  return `<section class="card half" aria-labelledby="operational-scope-heading"><h2 id="operational-scope-heading">Operational Scope</h2><p class="section-note">Cached/read-only snapshot. Secondary remotes were not scanned.</p>${table("Cached operational scope", ["Fact", "Value"], rows.map(([label, value]) => `<tr><th scope="row">${escape(label)}</th><td data-label="${escape(label)}">${escape(value)}</td></tr>`).join(""), "operational-scope-table")}<h3>Unscanned Secondary Remotes</h3><ul>${remotes}</ul></section>`;
}

function cleanCompletionProof(status: GuardianStatusResult) {
  if (!status.cleanCompletionProof) return "";
  const proof = status.cleanCompletionProof;
  const rows = [
    ["Status", proof.status],
    ...(proof.reason ? [["Reason", proof.reason]] : []),
    ...(proof.provenAt ? [["Proven At", proof.provenAt]] : []),
    ...(proof.inventoryDigest ? [["Inventory Digest", short(proof.inventoryDigest)]] : []),
    ...(proof.stateVersion === undefined ? [] : [["State Version", proof.stateVersion]]),
    ...(proof.worktreeCount === undefined ? [] : [["Worktrees", proof.worktreeCount]]),
    ...(proof.quarantineItemCount === undefined ? [] : [["Recoverable Quarantine Items", proof.quarantineItemCount]]),
  ];
  return `<section class="card half" aria-labelledby="clean-completion-proof-heading"><h2 id="clean-completion-proof-heading">Clean Completion Proof</h2><p class="section-note">Evidence recorded by the opt-in stable two-pass completion contract.</p>${table("Clean completion proof", ["Fact", "Value"], rows.map(([label, value]) => `<tr><th scope="row">${escape(label)}</th><td data-label="${escape(label)}"><code>${escape(value)}</code></td></tr>`).join(""), "clean-completion-proof-table")}</section>`;
}

export function renderEvidence(status: GuardianStatusResult, recover: GuardianRecoverResult) {
  const repoRoot = canonicalPath(status.repoRoot); const unowned = status.worktreesWithoutState.filter((entry) => canonicalPath(entry.path) !== repoRoot); const recovery = candidates(recover);
  return `<section class="grid" aria-label="Guardian evidence">${baseAuthority(status)}${operationalScope(status)}${cleanCompletionProof(status)}<section class="card" aria-labelledby="sessions-heading"><h2 id="sessions-heading">Sessions</h2>${sessions([...status.sessions])}</section><section class="card" aria-labelledby="worktrees-heading"><h2 id="worktrees-heading">Worktrees</h2>${worktrees([...status.worktrees])}</section><section class="card half" aria-labelledby="branch-coverage-heading"><h2 id="branch-coverage-heading">Branch Coverage</h2>${branches([...status.branchesWithoutWorktrees])}</section>${list("Orphaned Sessions", [...status.orphanedSessions], "risk", "No orphaned sessions detected.")}${list("Worktrees Without State", unowned, "risk", "No worktrees without Guardian state detected.")}${list("Dirty Files", [...status.dirtyFiles], "risk", "No dirty files detected.")}${list("Stashes", [...status.stashes], "risk", "No stashes detected.")}${hygiene(status.hygiene)}${list("Safety Refs", [...status.safetyRefs], "info", "No safety refs detected.")}${list("Recovery Candidates", recovery, "info", "No recovery candidates detected.")}<section class="card command-bank" aria-labelledby="recovery-guidance-heading"><h2 id="recovery-guidance-heading">Recovery Guidance</h2><p>Guardian-native planning guidance is available in Operations. Raw source values remain available only in Raw Data.</p></section></section>`;
}

export function renderVerdict(verdict: GuardianVerdict) {
  const next = verdict.nextAction?.includes("git ") ? "Use Guardian evidence before deciding on a plan." : verdict.nextAction;
  const label = verdict.tone === "good" ? "Ready" : verdict.tone === "warn" ? "Needs attention" : "Blocked";
  return `<section class="card verdict ${verdict.tone}" aria-labelledby="verdict-heading"><span class="status-pill ${verdict.tone}">${label}</span><h2 id="verdict-heading" class="verdict-headline">${escape(verdict.headline)}</h2>${next ? `<p class="verdict-next">Next: ${escape(next)}</p>` : ""}</section>`;
}
