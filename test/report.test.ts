import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianRecover, guardianStatus } from "../src/recover.ts";
import { guardianReportHtml, renderGuardianReportHtml } from "../src/report.ts";
import { getGuardianPaths } from "../src/state.ts";
import { createRepo, git, seedSession } from "./helpers.ts";

function maliciousReportHtml() {
  return renderGuardianReportHtml({
    reportPath: "/tmp/report\" onload=\"alert(1).html",
    generatedAt: "2026-05-20T00:00:00.000Z",
    status: {
      repoRoot: "/repo/<script>alert(1)</script>",
      sessions: [{
        session_id: "ses_<img src=x onerror=alert(1)>",
        status: "active",
        branch: "guardian/<script>alert(1)</script>",
        worktree_path: "/tmp/worktree\" onclick=\"alert(1)",
        head_commit: "abc123def456",
      }],
      worktrees: [{
        branch: "guardian/<svg onload=alert(1)>",
        path: "/tmp/worktree\" onmouseover=\"alert(1)",
        head: "abc123def456",
      }],
      orphanedSessions: [],
      worktreesWithoutState: [],
      branchesWithoutWorktrees: [],
      dirtyFiles: [],
      stashes: [],
      safetyRefs: [],
      hygiene: {
        ok: true,
        summary: {
          candidateCount: 9,
          findingCount: 2,
          exclusionCount: 1,
          bySeverity: { warn: 1, fail: 1 },
          byCategory: { "known-cleanable": 1, "nested-git": 1, suspicious: 0 },
        },
        findings: [{
          path: "research/<img src=x onerror=alert(1)>",
          category: "nested-git\" onmouseover=\"alert(1)",
          severity: "fail",
          reason: "nested <script>alert(1)</script> dirty repo",
        }, {
          path: "librarian-alpha",
          category: "known-cleanable",
          severity: "warn",
          reason: "known librarian scratch artifact",
        }],
      },
    },
    recover: {
      recoveryCandidates: [],
      suggestedCommands: ["guardian_status && echo '<script>'"],
    },
  });
}

test("guardian report HTML escapes script and event-handler-looking data", () => {
  const html = maliciousReportHtml();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /onerror&#61;alert\(1\)/);
  assert.match(html, /onclick&#61;/);
  assert.match(html, /nested &lt;script&gt;alert\(1\)&lt;\/script&gt; dirty repo/);
  assert.match(html, /onmouseover&#61;/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test("guardian report HTML is static and offline with restrictive CSP", () => {
  const html = maliciousReportHtml();
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src &#39;none&#39;/);
  assert.match(html, /script-src &#39;none&#39;/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test("guardian report HTML renders workspace hygiene summary and top findings", () => {
  const html = renderGuardianReportHtml({
    reportPath: "/tmp/report.html",
    generatedAt: "2026-05-20T00:00:00.000Z",
    status: {
      repoRoot: "/repo",
      sessions: [],
      worktrees: [],
      orphanedSessions: [],
      worktreesWithoutState: [],
      branchesWithoutWorktrees: [],
      dirtyFiles: [],
      stashes: [],
      safetyRefs: [],
      hygiene: {
        ok: true,
        summary: {
          candidateCount: 7,
          findingCount: 3,
          exclusionCount: 2,
          bySeverity: { warn: 2, fail: 1 },
          byCategory: { "known-cleanable": 1, "nested-git": 1, suspicious: 1 },
        },
        findings: [{
          path: "research-clone",
          category: "nested-git",
          severity: "fail",
          reason: "nested Git repository has uncommitted changes",
        }, {
          path: "librarian-alpha",
          category: "known-cleanable",
          severity: "warn",
          reason: "known librarian scratch artifact",
        }, {
          path: "scratch-dump",
          category: "suspicious",
          severity: "warn",
          reason: "untracked path resembles a clone, research dump, or scratch workspace",
        }],
      },
    },
    recover: { recoveryCandidates: [], suggestedCommands: [] },
  });

  assert.match(html, /Workspace Hygiene/);
  assert.match(html, /Candidate Paths/);
  assert.match(html, /Manual Review/);
  assert.doesNotMatch(html, /<span>Fail<\/span>/);
  assert.match(html, /Known Cleanable/);
  assert.match(html, /Nested Git/);
  assert.match(html, /Suspicious/);
  assert.match(html, /Top Findings By Review Level And Category/);
  assert.match(html, /research-clone/);
  assert.match(html, /nested Git repository has uncommitted changes/);
});

test("guardian report HTML renders escaped reviewable candidates separately from hygiene findings", () => {
  const html = renderGuardianReportHtml({
    reportPath: "/tmp/report.html",
    generatedAt: "2026-05-20T00:00:00.000Z",
    status: {
      repoRoot: "/repo",
      sessions: [],
      worktrees: [],
      orphanedSessions: [],
      worktreesWithoutState: [],
      branchesWithoutWorktrees: [],
      dirtyFiles: [],
      stashes: [],
      safetyRefs: [],
      hygiene: {
        ok: true,
        summary: {
          candidateCount: 1,
          findingCount: 0,
          exclusionCount: 0,
          reviewableCandidateCount: 1,
          reviewableShownCount: 1,
          reviewableOmittedCount: 0,
          reviewableTruncated: false,
          bySeverity: { warn: 0, fail: 0 },
          byCategory: { "known-cleanable": 0, "nested-git": 0, suspicious: 0 },
        },
        findings: [],
        reviewableCandidates: [{
          path: "review/<img src=x onerror=alert(1)>",
          status: "untracked",
          reason: "review <script>alert(1)</script> before deleting",
          source: "git ls-files --others/--ignored",
          suggestedDeletePathCommand: "guardian_delete_paths mode=plan paths=[\"review/<img src=x onerror=alert(1)>\"]",
        }],
      },
    },
    recover: { recoveryCandidates: [], suggestedCommands: [] },
  });

  assert.match(html, /Reviewable Candidates/);
  assert.match(html, /Plan exact deletes with guardian_delete_paths mode&#61;plan after review/);
  assert.match(html, /review\/&lt;img src&#61;x onerror&#61;alert\(1\)&gt;/);
  assert.match(html, /review &lt;script&gt;alert\(1\)&lt;\/script&gt; before deleting/);
  assert.match(html, /guardian_delete_paths mode&#61;plan paths&#61;\[&quot;review\/&lt;img src&#61;x onerror&#61;alert\(1\)&gt;&quot;\]/);
  assert.match(html, /<span>Risks<\/span><strong>0<\/strong>/);
  assert.match(html, /<span>Hygiene Findings<\/span><strong>0<\/strong>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test("guardian status and recover expose reviewable hygiene metadata", async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, ".gitignore"), "*.log\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "add reviewable ignores"]);
  await fs.writeFile(path.join(repo, "plain.log"), "ignored reviewable\n");
  await fs.writeFile(path.join(repo, "ordinary.txt"), "untracked reviewable\n");

  const status = await guardianStatus({ repoRoot: repo, config: DEFAULT_CONFIG });
  const recover = await guardianRecover({ repoRoot: repo, config: DEFAULT_CONFIG });

  assert.deepEqual(status.hygiene.reviewableCandidates.map((candidate) => candidate.path), ["ordinary.txt", "plain.log"]);
  assert.equal(status.hygiene.summary.reviewableCandidateCount, 2);
  assert.equal(status.hygiene.summary.reviewableShownCount, 2);
  assert.equal(status.hygiene.summary.reviewableOmittedCount, 0);
  assert.equal(status.hygiene.summary.reviewableTruncated, false);
  assert.deepEqual(recover.hygiene.reviewableCandidates, status.hygiene.reviewableCandidates);
  assert.deepEqual(recover.hygiene.summary, status.hygiene.summary);
});

test("guardian report integration writes repo-local report with session and worktree data", async () => {
  const repo = await createRepo();
  await seedSession(repo, {
    session_id: "ses_report",
    status: "active",
    branch: "guardian/report",
    worktree_path: repo,
    base_ref: "origin/main",
    head_commit: "abc123def456",
    safety_refs: [],
  });

  const result = await guardianReportHtml({ repoRoot: repo, config: DEFAULT_CONFIG });
  const paths = await getGuardianPaths(repo);
  assert.equal(result.ok, true);
  assert.equal(result.reportPath, paths.reportPath);
  assert.match(result.reportPath, /\.git\/opencode-guardian\/report\.html$/);

  const html = await fs.readFile(paths.reportPath, "utf8");
  assert.match(html, /ses_report/);
  assert.match(html, /guardian\/report/);
  assert.match(html, /Control Report/);
  assert.match(html, /Raw Guardian JSON/);
  assert.match(html, /Workspace Hygiene/);
});
