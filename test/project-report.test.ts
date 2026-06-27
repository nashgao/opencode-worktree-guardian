import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderProjectReportHtml, writeProjectReport } from "../src/project/report.ts";
import { getGuardianPaths } from "../src/state.ts";
import { createRepo, createTempDir } from "./helpers.ts";

test("project intelligence report HTML is static escaped and script-free", () => {
  const html = renderProjectReportHtml({
    reportPath: "/tmp/project-report.html",
    snapshot: {
      ok: true,
      schemaVersion: "project-snapshot/v1",
      generatedAt: "2026-06-24T00:00:00.000Z",
      repoRoot: "/repo/<script>alert(1)</script>",
      projectRoots: ["/repo"],
      guardian: {
        repoRoot: "/repo",
        stateVersion: 1,
        activeSessionCount: 0,
        worktreeCount: 1,
        dirtyFileCount: 0,
        safetyRefCount: 0,
        warningCount: 1,
      },
      projects: [{
        root: "/repo",
        name: "repo<script>alert(1)</script>",
        relativeRoot: ".",
        git: { available: true, branch: "main", head: "abc123", dirtyFileCount: 0 },
        roadmaps: [{
          path: "definition/roadmap.md",
          title: "Roadmap <img src=x onerror=alert(1)>",
          sections: ["Now"],
          phases: [{ section: "Now", title: "Phase <script>alert(1)</script>", checklist: { total: 1, done: 0, pending: 1 } }],
          checklist: { total: 1, done: 0, pending: 1 },
          tableRows: [],
        }],
        milestoneReviews: [],
        omoPlans: [],
        omoLoops: [],
        warnings: [{ code: "demo", message: "warning <script>alert(1)</script>", path: "demo.md" }],
      }],
      summary: {
        projectCount: 1,
        roadmapCount: 1,
        milestoneReviewCount: 0,
        omoPlanCount: 0,
        omoLoopCount: 0,
        warningCount: 1,
      },
      warnings: [{ code: "demo", message: "warning <script>alert(1)</script>", path: "demo.md" }],
    },
  });

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src &#39;none&#39;/);
  assert.match(html, /Project Intelligence/);
  assert.match(html, /Roadmap &lt;img src&#61;x onerror&#61;alert\(1\)&gt;/);
  assert.match(html, /warning &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test("project intelligence report writes only project-report html", async () => {
  const repo = await createRepo();
  await fs.mkdir(path.join(repo, "definition"), { recursive: true });
  await fs.writeFile(path.join(repo, "definition", "roadmap.md"), "# Report Roadmap\n");
  const paths = await getGuardianPaths(repo);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.reportPath, "existing guardian report\n");

  const result = await writeProjectReport({ repoRoot: repo, cwd: repo, generatedAt: "2026-06-24T00:00:00.000Z" });
  const html = await fs.readFile(result.reportPath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.reportPath, path.join(paths.dir, "project-report.html"));
  assert.equal(await fs.readFile(paths.reportPath, "utf8"), "existing guardian report\n");
  assert.match(html, /Report Roadmap/);
  assert.doesNotMatch(html, /<script/i);
});

test("project intelligence report refuses symlink project-report target", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const outside = await createTempDir("guardian-project-report-target-");
  const target = path.join(outside, "target.html");
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(target, "outside\n");
  await fs.symlink(target, path.join(paths.dir, "project-report.html"));

  await assert.rejects(
    () => writeProjectReport({ repoRoot: repo, cwd: repo, generatedAt: "2026-06-24T00:00:00.000Z" }),
    /Refusing project report symlink/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "outside\n");
});

test("project intelligence report refuses symlink report directory", async () => {
  const repo = await createRepo();
  const paths = await getGuardianPaths(repo);
  const outside = await createTempDir("guardian-project-report-dir-target-");
  await fs.mkdir(path.dirname(paths.dir), { recursive: true });
  await fs.symlink(outside, paths.dir);

  await assert.rejects(
    () => writeProjectReport({ repoRoot: repo, cwd: repo, generatedAt: "2026-06-24T00:00:00.000Z" }),
    /Refusing project report directory symlink/,
  );
  assert.equal(await fs.access(path.join(outside, "project-report.html")).then(() => true, () => false), false);
});
