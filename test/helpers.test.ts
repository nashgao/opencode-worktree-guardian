import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRepo, createRepoWithOrigin, createTempDir } from "./helpers.ts";

function isSameOrInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function withProjectTempEnv<T>(callback: () => Promise<T>) {
  const original = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  const projectRoot = await fs.realpath(process.cwd());
  process.env.TMPDIR = projectRoot;
  process.env.TMP = projectRoot;
  process.env.TEMP = projectRoot;
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function assertOutsideProject(candidate: string) {
  const projectRoot = await fs.realpath(process.cwd());
  const realCandidate = await fs.realpath(candidate);
  assert.equal(isSameOrInside(realCandidate, projectRoot), false, `${realCandidate} must be outside ${projectRoot}`);
}

test("createTempDir stays outside the project when TMPDIR points at the project", async (t) => {
  const directory = await withProjectTempEnv(() => createTempDir("guardian-helper-regression-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assertOutsideProject(directory);
});

test("createRepo stays outside the project when TMPDIR points at the project", async (t) => {
  const repo = await withProjectTempEnv(() => createRepo());
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await assertOutsideProject(repo);
});

test("createRepoWithOrigin stays outside the project when TMPDIR points at the project", async (t) => {
  const { base, repo, remote } = await withProjectTempEnv(() => createRepoWithOrigin());
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await assertOutsideProject(base);
  await assertOutsideProject(repo);
  await assertOutsideProject(remote);
});
