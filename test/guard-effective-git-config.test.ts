import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyGuardCommand, classifyNormalAgentGitCommand } from "../src/guards.ts";
import { createRef, createSafetyRef, deleteBranch, deleteBranchAtHead, fetchRemote, getBranchCommit, getBranchUpstream, getRefCommit, isAncestor, listRefs, listUnmergedCommits } from "../src/git.ts";
import { createRepo, createRepoWithOrigin, createTempDir, git } from "./helpers.ts";

function assertBlocked(command: string, options: Record<string, unknown>): void {
  assert.equal(classifyGuardCommand(command, options).blocked, true, command);
  assert.equal(classifyNormalAgentGitCommand(command, options).allowed, false, command);
}

function assertAllowed(command: string, options: Record<string, unknown>): void {
  assert.equal(classifyGuardCommand(command, options).blocked, false, command);
  assert.equal(classifyNormalAgentGitCommand(command, options).allowed, true, command);
}

type GitRefusalCheck = { readonly marker: string; readonly bin: string; readonly command: () => Promise<unknown>; readonly errorPattern: RegExp; readonly markedCommand?: string };

async function assertRefusedBeforeGit({ marker, bin, command, errorPattern, markedCommand }: GitRefusalCheck) {
  const originalPath = process.env.PATH;
  const originalMarker = process.env.GUARDIAN_GIT_MARKER;
  const originalRealPath = process.env.GUARDIAN_REAL_PATH;
  const originalMarkedCommand = process.env.GUARDIAN_MARKED_COMMAND;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.GUARDIAN_GIT_MARKER = marker;
  process.env.GUARDIAN_REAL_PATH = originalPath ?? "";
  if (markedCommand === undefined) delete process.env.GUARDIAN_MARKED_COMMAND;
  else process.env.GUARDIAN_MARKED_COMMAND = markedCommand;
  let failure: unknown;
  try {
    try {
      await command();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error;
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalMarker === undefined) delete process.env.GUARDIAN_GIT_MARKER;
    else process.env.GUARDIAN_GIT_MARKER = originalMarker;
    if (originalRealPath === undefined) delete process.env.GUARDIAN_REAL_PATH;
    else process.env.GUARDIAN_REAL_PATH = originalRealPath;
    if (originalMarkedCommand === undefined) delete process.env.GUARDIAN_MARKED_COMMAND;
    else process.env.GUARDIAN_MARKED_COMMAND = originalMarkedCommand;
  }
  await assert.rejects(fs.access(marker));
  assert.ok(failure instanceof Error);
  assert.match(failure.message, errorPattern);
}

for (const [command, config] of [
  ["git push origin", "remote.origin.mirror=true"],
  ["git push origin", "remote.origin.mirror=yes"],
  ["git push origin", "remote.origin.mirror=on"],
  ["git push origin", "remote.origin.mirror=1"],
  ["git push origin.backup", "remote.origin.backup.mirror=true"],
] satisfies readonly (readonly [string, string])[]) {
  const mirror = config.split("=")[1];
  test(`blocks effective mirror=${mirror} push configuration for ${command}`, () => {
    assertBlocked(command, {
      inspection: { state: "available", aliases: [], transportConfigs: [config], currentHead: null },
    });
  });
}

for (const mirror of ["false", "no", "off", "0"]) {
  test(`permits an explicit effective mirror=${mirror} control`, () => {
    assertAllowed("git push origin", {
      inspection: {
        state: "available",
        aliases: [],
        transportConfigs: [`remote.origin.mirror=${mirror}`],
        currentHead: null,
      },
    });
  });
}

for (const config of [
  "remote.origin.push=+HEAD:refs/heads/feature",
  "remote.origin.push=:refs/heads/main",
]) {
  test(`blocks effective unsafe push refspec ${config}`, () => {
    assertBlocked("git push origin", {
      inspection: { state: "available", aliases: [], transportConfigs: [config], currentHead: null },
    });
  });
}

test("permits ordinary effective refspec mappings", () => {
  assertAllowed("git push origin", {
    inspection: {
      state: "available",
      aliases: [],
      transportConfigs: ["remote.origin.push=HEAD:refs/heads/feature"],
      currentHead: null,
    },
  });
});

test("blocks effective protected-source mappings with equivalent Guardian HEAD identities", () => {
  const currentHead = "0123456789012345678901234567890123456789";
  for (const source of ["HEAD~00", "@~0", currentHead.slice(0, 12)]) {
    assertBlocked("git push Origin", {
      protectedBranches: ["main"],
      branchPrefix: "guardian/",
      inspection: {
        state: "available",
        aliases: [],
        transportConfigs: [`remote.Origin.push=${source}:refs/heads/main`],
        currentHead,
      },
      revisionIdentities: [{ source, oid: currentHead }],
    });
  }
});

test("permits a differently-cased remote outside an effective protected-source mapping", () => {
  const currentHead = "0123456789012345678901234567890123456789";
  assertAllowed("git push origin", {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    inspection: {
      state: "available",
      aliases: [],
      transportConfigs: ["remote.Origin.push=HEAD~00:refs/heads/main"],
      currentHead,
    },
    revisionIdentities: [{ source: "HEAD~00", oid: currentHead }],
  });
});

test("scopes effective protected-source push configuration to the selected remote", () => {
  assertAllowed("git push safe", {
    protectedBranches: ["main"],
    branchPrefix: "guardian/",
    currentBranch: "guardian/source",
    inspection: {
      state: "available",
      aliases: [],
      transportConfigs: ["remote.danger.push=refs/heads/guardian/source:refs/heads/main"],
      currentHead: null,
    },
  });
});

test("blocks the invoked effective Git alias", () => {
  assertBlocked("git guardian-nuke", {
    inspection: {
      state: "available",
      aliases: ["guardian-nuke"],
      transportConfigs: [],
      currentHead: null,
    },
  });
});

test("blocks the invoked effective Git alias regardless of invocation case", () => {
  assertBlocked("git GUARDIAN-NUKE", {
    inspection: {
      state: "available",
      aliases: ["guardian-nuke"],
      transportConfigs: [],
      currentHead: null,
    },
  });
});

test("denies an effective transport inspection failure", () => {
  assertBlocked("git fetch origin", {
    inspection: { state: "failed", stage: "git-config", reason: "git config inspection failed" },
  });
});

test("ref command boundary rejects malformed base refs before Git starts", async (t) => {
  // Given a real repository and a fake Git command runner.
  const repo = await createRepo();
  const toolRoot = await createTempDir("guardian-ref-boundary-tools-");
  t.after(async () => fs.rm(repo, { recursive: true, force: true }));
  t.after(async () => fs.rm(toolRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(toolRoot, "git"), '#!/bin/sh\nif [ "$3" = config ]; then PATH="$GUARDIAN_REAL_PATH" exec git "$@"; fi\nif [ -z "$GUARDIAN_MARKED_COMMAND" ] || [ "$3" = "$GUARDIAN_MARKED_COMMAND" ]; then : > "$GUARDIAN_GIT_MARKER"; exit 94; fi\nPATH="$GUARDIAN_REAL_PATH" exec git "$@"\n');
  await fs.chmod(path.join(toolRoot, "git"), 0o755);
  const malformedRefs = ["", "--upload-pack=/tmp/marker", "refs/heads/base..branch", "refs//heads/main", "refs/heads/.hidden", "refs/heads/topic.lock"];

  for (const [index, ref] of malformedRefs.entries()) {
    // When branch, ref, and revision-range entry points receive malformed base references.
    for (const [commandIndex, command] of [
      () => getBranchUpstream(repo, ref),
      () => getBranchCommit(repo, ref),
      () => getRefCommit(repo, ref),
      () => isAncestor(repo, "HEAD", ref),
      () => listRefs(repo, ref),
      () => listUnmergedCommits(repo, "HEAD", ref),
      () => createRef(repo, ref),
      () => createSafetyRef(repo, { ref }),
      () => deleteBranch(repo, ref),
      () => deleteBranchAtHead(repo, ref, "HEAD"),
    ].entries()) {
      const marker = path.join(toolRoot, `git-${index}-${commandIndex}.marker`);
      await assertRefusedBeforeGit({ marker, bin: toolRoot, command, errorPattern: /ref|branch/i });

      // Then no Git process gets an opportunity to parse the input.
    }
  }
});

test("remote command boundary accepts configured remote names containing slash", async (t) => {
  // Given a real configured remote whose name includes a slash.
  const { base, repo, remote } = await createRepoWithOrigin();
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  await git(repo, ["remote", "add", "trusted/team", remote]);

  // When Guardian fetches through that configured remote.
  await fetchRemote(repo, "trusted/team");

  // Then the fetch succeeds without treating the slash as malformed.
  assert.equal((await git(repo, ["remote", "get-url", "trusted/team"])).stdout, remote);
});

test("revision boundary accepts expected object IDs, HEAD, and full ref prefixes", async (t) => {
  const { base, repo } = await createRepoWithOrigin();
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout;

  assert.equal(await isAncestor(repo, head, "HEAD"), true);
  assert.equal((await listRefs(repo, "refs/heads")).some((ref) => ref.name === "refs/heads/main"), true);
});

test("remote command boundary honors effective include, global, and worktree configuration", async (t) => {
  // Given local, conditional, global, and worktree configuration sources with quoted remote names.
  const { base, repo, remote } = await createRepoWithOrigin();
  const configRoot = await createTempDir("guardian-effective-remote-config-");
  const home = path.join(configRoot, "home");
  const include = path.join(configRoot, "included.config");
  const conditionalInclude = path.join(configRoot, "conditional.config");
  const originalHome = process.env.HOME;
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  t.after(async () => fs.rm(configRoot, { recursive: true, force: true }));
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(include, `[remote "Included/Remote"]\n\turl = ${remote}\n`);
  await fs.writeFile(conditionalInclude, `[remote "Conditional/Remote"]\n\turl = ${remote}\n`);
  await fs.appendFile(path.join(repo, ".git", "config"), `[include]\n\tpath = ${include}\n[includeIf "gitdir:${path.join(repo, ".git")}"]\n\tpath = ${conditionalInclude}\n`);
  process.env.HOME = home;
  await git(repo, ["config", "--global", "remote.Global/Remote.url", remote]);
  await git(repo, ["config", "extensions.worktreeConfig", "true"]);
  await git(repo, ["config", "--worktree", "remote.Worktree/Remote.url", remote]);
  await git(repo, ["remote", "add", "Quoted/Remote", remote]);

  // When Guardian resolves remotes from effective Git configuration.
  for (const remoteName of ["Included/Remote", "Conditional/Remote", "Global/Remote", "Worktree/Remote", "Quoted/Remote"]) await fetchRemote(repo, remoteName);
  await git(repo, ["remote", "add", "Removed/Remote", remote]);
  await git(repo, ["remote", "remove", "Removed/Remote"]);

  // Then exact configured names work and removed or case-mismatched names remain unavailable.
  await assert.rejects(fetchRemote(repo, "Removed/Remote"), /remote/i);
  await assert.rejects(fetchRemote(repo, "quoted/remote"), /remote/i);
});
