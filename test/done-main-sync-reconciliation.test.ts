import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { syncLocalBase } from "../src/done-main-sync.ts";
import { createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const configPath = ".opencode/worktree-guardian.json";

async function setupIncomingConfig() {
  const { base, remote, repo } = await createRepoWithOrigin();
  await fs.mkdir(path.join(repo, path.dirname(configPath)), { recursive: true });
  await fs.writeFile(path.join(repo, configPath), "old config\n");
  await git(repo, ["add", configPath]);
  await git(repo, ["commit", "-m", "track config"]);
  await git(repo, ["push", "origin", "main"]);

  const publisher = await createTempDir("guardian-main-sync-publisher-");
  await execFileAsync("git", ["clone", "--quiet", "--branch", "main", remote, publisher]);
  await git(publisher, ["config", "user.email", "guardian@example.test"]);
  await git(publisher, ["config", "user.name", "Guardian Test"]);
  await fs.writeFile(path.join(publisher, configPath), "incoming config\n");
  await fs.writeFile(path.join(publisher, "remote-only.txt"), "remote only\n");
  await git(publisher, ["add", configPath, "remote-only.txt"]);
  await git(publisher, ["commit", "-m", "advance remote config"]);
  await git(publisher, ["push", "origin", "main"]);
  const remoteHead = (await git(publisher, ["rev-parse", "HEAD"])).stdout;
  return { base, repo, remoteHead };
}

test("syncLocalBase reconciles an unstaged tracked file that exactly matches the incoming base", async (t) => {
  const fixture = await setupIncomingConfig();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.repo, configPath), "incoming config\n");

  const result = await syncLocalBase(fixture.repo, DEFAULT_CONFIG);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.fastForwarded, true);
  assert.deepEqual(result.reconciledDirtyFiles, [configPath]);
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, fixture.remoteHead);
  assert.equal((await git(fixture.repo, ["status", "--short"])).stdout, "");
  assert.equal(await fs.readFile(path.join(fixture.repo, configPath), "utf8"), "incoming config\n");
});

test("syncLocalBase preserves a dirty file whose bytes differ from the incoming base", async (t) => {
  const fixture = await setupIncomingConfig();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const localHead = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(fixture.repo, configPath), "local config\n");

  const result = await syncLocalBase(fixture.repo, DEFAULT_CONFIG);

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /uncommitted changes/);
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, localHead);
  assert.equal(await fs.readFile(path.join(fixture.repo, configPath), "utf8"), "local config\n");
});

test("syncLocalBase preserves staged changes even when their bytes match the incoming base", async (t) => {
  const fixture = await setupIncomingConfig();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const localHead = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(fixture.repo, configPath), "incoming config\n");
  await git(fixture.repo, ["add", configPath]);

  const result = await syncLocalBase(fixture.repo, DEFAULT_CONFIG);

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /uncommitted changes/);
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, localHead);
  assert.equal((await git(fixture.repo, ["diff", "--cached", "--name-only"])).stdout, configPath);
});

test("syncLocalBase preserves an untracked file even when its bytes match an incoming tracked file", async (t) => {
  const fixture = await setupIncomingConfig();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const localHead = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout;
  await fs.writeFile(path.join(fixture.repo, "remote-only.txt"), "remote only\n");

  const result = await syncLocalBase(fixture.repo, DEFAULT_CONFIG);

  assert.equal(result.ok, false);
  assert.match(String(result.reason), /uncommitted changes/);
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout, localHead);
  assert.equal((await git(fixture.repo, ["status", "--short"])).stdout, "?? remote-only.txt");
});
