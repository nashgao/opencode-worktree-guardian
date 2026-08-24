import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { projectRoot, run } from "./package-smoke-helpers.ts";

const testTempParent = path.join(os.homedir(), ".cache", "opencode", "worktree-guardian-tests");
const CoverageEnvironmentSchema = z.object({
  capability: z.string(),
  compile: z.string(),
  coverage: z.string(),
  root: z.string(),
  tmp: z.string(),
});
const NestedCoverageEnvironmentSchema = z.object({
  outer: z.object({ compile: z.string(), root: z.string() }),
  inner: CoverageEnvironmentSchema,
});

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseEnvironment(line: string): z.infer<typeof CoverageEnvironmentSchema> {
  return CoverageEnvironmentSchema.parse(JSON.parse(line));
}

async function createTestBase(prefix: string): Promise<string> {
  await fs.mkdir(testTempParent, { recursive: true });
  return fs.mkdtemp(path.join(testTempParent, prefix));
}

function isolatedCoverageEnvironment(base: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TMPDIR: base,
    TMP: base,
    TEMP: base,
    NODE_V8_COVERAGE: "",
    NODE_COMPILE_CACHE: "",
    OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN: "",
    OPENCODE_WORKTREE_GUARDIAN_COVERAGE_CAPABILITY: "",
    ...overrides,
  };
}

const printEnvironment = "process.stdout.write(JSON.stringify({ root: process.env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN, coverage: process.env.NODE_V8_COVERAGE, compile: process.env.NODE_COMPILE_CACHE, capability: process.env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_CAPABILITY, tmp: process.env.TMPDIR }) + '\\n')";

test("coverage wrapper allocates capability-owned paths and rejects symlinked project aliases", async (t) => {
  const base = await createTestBase("coverage-isolation-");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  const alias = path.join(base, "project-alias");
  await fs.mkdir(project);
  await fs.symlink(project, alias, "dir");

  const wrapper = path.join(projectRoot, "scripts", "with-safe-node-temp.mjs");
  const args = [wrapper, "--", process.execPath, "--experimental-test-coverage", "-e", printEnvironment];
  const first = await run(process.execPath, args, { cwd: project, env: isolatedCoverageEnvironment(base, { NODE_V8_COVERAGE: path.join(alias, "coverage") }) });
  const second = await run(process.execPath, args, { cwd: project, env: isolatedCoverageEnvironment(base, { NODE_V8_COVERAGE: path.join(alias, "coverage") }) });
  const firstEnvironment = parseEnvironment(first.stdout.trim());
  const secondEnvironment = parseEnvironment(second.stdout.trim());

  assert.equal(isSameOrInside(await fs.realpath(path.dirname(firstEnvironment.root)), await fs.realpath(project)), false);
  assert.equal(path.dirname(firstEnvironment.coverage), firstEnvironment.root);
  assert.equal(path.dirname(firstEnvironment.compile), firstEnvironment.root);
  assert.notEqual(firstEnvironment.root, secondEnvironment.root);
  assert.notEqual(firstEnvironment.capability, secondEnvironment.capability);
  await Promise.all([
    assert.rejects(fs.access(firstEnvironment.root), { code: "ENOENT" }),
    assert.rejects(fs.access(secondEnvironment.root), { code: "ENOENT" }),
  ]);
});

test("coverage wrapper preserves valid caller-owned external coverage without a coverage request", async (t) => {
  const base = await createTestBase("coverage-external-");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  const coverage = path.join(base, "caller-coverage");
  const compile = path.join(base, "caller-compile");
  await Promise.all([fs.mkdir(project), fs.mkdir(coverage), fs.mkdir(compile)]);

  const wrapper = path.join(projectRoot, "scripts", "with-safe-node-temp.mjs");
  const result = await run(process.execPath, [wrapper, "--", process.execPath, "-e", printEnvironment], {
    cwd: project,
    env: isolatedCoverageEnvironment(base, { NODE_V8_COVERAGE: coverage, NODE_COMPILE_CACHE: compile }),
  });
  const environment = parseEnvironment(result.stdout.trim());

  assert.equal(environment.root, "");
  assert.equal(environment.capability, "");
  assert.equal(environment.coverage, coverage);
  assert.equal(environment.compile, compile);
  await Promise.all([fs.access(coverage), fs.access(compile)]);
});

test("coverage wrapper reuses only its nested capability context and leaves forged paths untouched", async (t) => {
  const base = await createTestBase("coverage-capability-");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  const forged = path.join(base, "forged-run");
  await Promise.all([fs.mkdir(project), fs.mkdir(path.join(forged, "coverage"), { recursive: true }), fs.mkdir(path.join(forged, "compile-cache"), { recursive: true })]);
  await fs.writeFile(path.join(forged, ".owg-coverage-capability"), "forged-token", { mode: 0o600 });

  const wrapper = path.join(projectRoot, "scripts", "with-safe-node-temp.mjs");
  const nestedScript = `
    import { execFileSync } from "node:child_process";
    const outer = { root: process.env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN, compile: process.env.NODE_COMPILE_CACHE };
    const output = execFileSync(process.execPath, [${JSON.stringify(wrapper)}, "--", process.execPath, "--experimental-test-coverage", "-e", ${JSON.stringify(printEnvironment)}], { env: process.env, encoding: "utf8" });
    process.stdout.write(JSON.stringify({ outer, inner: JSON.parse(output) }) + "\\n");
  `;
  const nested = await run(process.execPath, [wrapper, "--", process.execPath, "--experimental-test-coverage", "--input-type=module", "-e", nestedScript], {
    cwd: project,
    env: isolatedCoverageEnvironment(base),
  });
  const nestedResult = NestedCoverageEnvironmentSchema.parse(JSON.parse(nested.stdout.trim()));
  assert.equal(nestedResult.outer.root, nestedResult.inner.root);
  assert.equal(nestedResult.outer.compile, nestedResult.inner.compile);

  const forgedResult = await run(process.execPath, [wrapper, "--", process.execPath, "--experimental-test-coverage", "-e", printEnvironment], {
    cwd: project,
    env: isolatedCoverageEnvironment(base, {
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN: forged,
      OPENCODE_WORKTREE_GUARDIAN_COVERAGE_CAPABILITY: "forged-token",
      NODE_V8_COVERAGE: path.join(forged, "coverage"),
      NODE_COMPILE_CACHE: path.join(forged, "compile-cache"),
    }),
  });
  const forgedEnvironment = parseEnvironment(forgedResult.stdout.trim());
  assert.notEqual(forgedEnvironment.root, forged);
  await Promise.all([fs.access(forged), fs.access(path.join(forged, "coverage")), fs.access(path.join(forged, "compile-cache"))]);
});

test("coverage wrapper refuses to clean a root replaced with a symlink", async (t) => {
  const base = await createTestBase("coverage-cleanup-");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  const sentinel = path.join(base, "sentinel");
  await Promise.all([fs.mkdir(project), fs.mkdir(sentinel)]);
  await fs.writeFile(path.join(sentinel, "preserve.txt"), "preserve");

  const wrapper = path.join(projectRoot, "scripts", "with-safe-node-temp.mjs");
  const childScript = "import fs from 'node:fs'; const root = process.env.OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN; fs.rmSync(root, { recursive: true, force: true }); fs.symlinkSync(process.env.SENTINEL, root, 'dir'); process.stdout.write(JSON.stringify({ root }) + '\\n');";
  const result = await run(process.execPath, [wrapper, "--", process.execPath, "--experimental-test-coverage", "--input-type=module", "-e", childScript], {
    cwd: project,
    env: isolatedCoverageEnvironment(base, { SENTINEL: sentinel }),
    exitMode: "capture",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(await fs.readFile(path.join(sentinel, "preserve.txt"), "utf8"), "preserve");
});
