import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianReportHtml, renderGuardianReportHtml } from "../src/report.ts";
import { getGuardianPaths, recordSession } from "../src/state.ts";
import { createRepo } from "./helpers.ts";

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

test("guardian report integration writes repo-local report with session and worktree data", async () => {
  const repo = await createRepo();
  await recordSession(repo, DEFAULT_CONFIG, {
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
});
