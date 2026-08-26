import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { guardianDeletePaths } from "../src/delete-paths.ts";
import { listTrackedAddedPaths } from "../src/hygiene-candidates.ts";
import { createRepo, git } from "./helpers.ts";

async function deleteTracked(repo: string, target: string): Promise<void> {
  const request = { repoRoot: repo, config: DEFAULT_CONFIG, paths: [target], allowTracked: true };
  const plan = await guardianDeletePaths({ ...request, mode: "plan" });
  const applied = await guardianDeletePaths({ ...request, mode: "apply", confirmDelete: true, confirmToken: plan.confirmToken });
  assert.equal(applied.status, "deleted", JSON.stringify(applied));
}

test("guardian_delete_paths removes a staged addition from the index", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const baseline = (await git(repo, ["rev-parse", "HEAD"])).stdout;
  const artifact = "screenshots/debug.png";
  await fs.mkdir(path.join(repo, "screenshots"));
  await fs.writeFile(path.join(repo, artifact), "debug\n");
  await git(repo, ["add", "--", artifact]);

  await deleteTracked(repo, artifact);

  assert.deepEqual(await listTrackedAddedPaths(repo, baseline), []);
  assert.equal((await git(repo, ["ls-files", "--", artifact])).stdout, "");
});

test("guardian_delete_paths requires allowTracked and stages a baseline tracked deletion", async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src/old.ts"), "export const old = true;\n");
  await git(repo, ["add", "src/old.ts"]);
  await git(repo, ["commit", "-m", "add tracked source"]);

  const blocked = await guardianDeletePaths({ repoRoot: repo, config: DEFAULT_CONFIG, mode: "plan", paths: ["src/old.ts"] });
  assert.equal(blocked.status, "blocked");
  assert.match(String(blocked.reason), /fatal blockers/);
  assert.match(String((blocked.blockers as Array<Record<string, unknown>>)[0]?.reason), /allowTracked=true/);

  await deleteTracked(repo, "src/old.ts");

  assert.equal((await git(repo, ["diff", "--cached", "--name-only", "--diff-filter=D", "--", "src/old.ts"])).stdout, "src/old.ts");
});
