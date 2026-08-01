import { spawn } from "node:child_process";
import { artifactEnvironment, assertReferenceTransactionHookSafe, controlledGitEnvironment, runGitWithEnvironment } from "./git-command-classifier.ts";
import type { GitArtifactSandbox } from "./git-command-classifier.ts";

const TRUSTED_REMOTE_NAMESPACE_OVERLAP = "Trusted upstream remote namespaces overlap:";
const PROMOTION_TIMEOUT_MS = 30_000;
const REF_DISALLOWED_CHARACTERS = /[\u0000-\u0020\u007f~^:?*\[\\]/;
const INVALID_GIT_REF = "Invalid Git ref";
const AMBIGUOUS_REMOTE_AUTHORITY = "Ambiguous upstream remote authority";

export type RemoteAuthority = {
  readonly remote: string;
  readonly branch: string;
  readonly displayRef: string;
  readonly authorityRef: string;
};

export function trustedRemoteNames(config: Record<string, unknown>): readonly string[] {
  const configured = String(config.remote);
  const additional = Array.isArray(config.trustedUpstreamRemotes)
    ? config.trustedUpstreamRemotes.filter((value): value is string => typeof value === "string")
    : [];
  const remotes = [...new Set([configured, ...additional])].sort((left, right) => right.length - left.length);
  for (const remote of remotes) {
    const overlapping = remotes.find((candidate) => candidate !== remote && remote.startsWith(`${candidate}/`));
    if (overlapping) {
      const [first, second] = [remote, overlapping].sort();
      throw new Error(`${TRUSTED_REMOTE_NAMESPACE_OVERLAP} ${first} and ${second}`);
    }
  }
  return remotes;
}

export function isTrustedRemoteNamespaceOverlapError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(TRUSTED_REMOTE_NAMESPACE_OVERLAP);
}

function isSafeRemoteName(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function isSafeRemoteBranch(value: string): boolean {
  return value.length > 0
    && value !== "@"
    && !value.startsWith("-")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("@{")
    && !REF_DISALLOWED_CHARACTERS.test(value)
    && value.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
}

function createRemoteAuthority(remote: string, branch: string): RemoteAuthority {
  if (!isSafeRemoteName(remote)) throw new Error(`Unsafe upstream remote name: ${remote}`);
  if (!isSafeRemoteBranch(branch)) throw new Error(INVALID_GIT_REF);
  return {
    remote,
    branch,
    displayRef: `${remote}/${branch}`,
    authorityRef: `refs/remotes/${remote}/${branch}`,
  };
}

function remoteRefForms(ref: string): readonly string[] {
  if (ref.startsWith("refs/remotes/")) return [ref, ref.slice("refs/remotes/".length)];
  if (ref.startsWith("remotes/")) return [ref, ref.slice("remotes/".length)];
  return [ref];
}

export function resolveRemoteAuthority(ref: string, config: Record<string, unknown>): RemoteAuthority {
  const remotes = trustedRemoteNames(config);
  const matches = new Map<string, RemoteAuthority>();
  for (const form of remoteRefForms(ref)) {
    for (const remote of remotes) {
      if (!form.startsWith(`${remote}/`)) continue;
      const authority = createRemoteAuthority(remote, form.slice(remote.length + 1));
      matches.set(`${authority.remote}\0${authority.branch}`, authority);
    }
  }
  if (matches.size === 0) {
    const candidate = remoteRefForms(ref).at(-1)?.split("/")[0] ?? ref;
    throw new Error(`Untrusted upstream remote ${candidate}; add it to trustedUpstreamRemotes to use it as a Guardian base`);
  }
  if (matches.size > 1) throw new Error(AMBIGUOUS_REMOTE_AUTHORITY);
  for (const authority of matches.values()) return authority;
  throw new Error(AMBIGUOUS_REMOTE_AUTHORITY);
}

export function configuredRemoteAuthority(config: Record<string, unknown>): RemoteAuthority {
  trustedRemoteNames(config);
  return createRemoteAuthority(String(config.remote), String(config.baseBranch));
}

function promotePack(repoPath: string, candidateTree: string, environment: NodeJS.ProcessEnv, targetObjects: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pack = spawn("git", ["-C", repoPath, "pack-objects", "--revs", "--stdout"], { env: environment, stdio: ["pipe", "pipe", "pipe"], timeout: PROMOTION_TIMEOUT_MS, killSignal: "SIGTERM" });
    const index = spawn("git", ["-C", repoPath, "index-pack", "--stdin", "--fix-thin"], { env: { ...controlledGitEnvironment(), GIT_OBJECT_DIRECTORY: targetObjects }, stdio: ["pipe", "ignore", "pipe"], timeout: PROMOTION_TIMEOUT_MS, killSignal: "SIGTERM" });
    let packClosed = false;
    let indexClosed = false;
    let settled = false;
    let stderr = "";
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      pack.kill("SIGTERM");
      index.kill("SIGTERM");
      reject(error);
    };
    const complete = (): void => {
      if (settled || !packClosed || !indexClosed) return;
      settled = true;
      resolve();
    };
    pack.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    index.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    pack.on("error", (error: Error) => fail(error));
    index.on("error", (error: Error) => fail(error));
    pack.on("close", (code) => {
      if (code !== 0) return fail(new Error(`git pack-objects failed with exit code ${code}: ${stderr.trim()}`));
      packClosed = true;
      complete();
    });
    index.on("close", (code) => {
      if (code !== 0) return fail(new Error(`git index-pack failed with exit code ${code}: ${stderr.trim()}`));
      indexClosed = true;
      complete();
    });
    pack.stdout.pipe(index.stdin);
    pack.stdin.end(`${candidateTree}\n`);
  });
}

export async function promoteGitArtifactSandboxTree(repoPath: string, sandbox: GitArtifactSandbox, candidateTree: string): Promise<void> {
  await assertReferenceTransactionHookSafe(repoPath);
  const environment = artifactEnvironment(sandbox);
  const targetObjects = environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  if (!targetObjects) throw new Error("Guardian artifact sandbox has no target object database");
  await promotePack(repoPath, candidateTree, environment, targetObjects);
  await runGitWithEnvironment(repoPath, ["cat-file", "-e", `${candidateTree}^{tree}`], {}, controlledGitEnvironment());
}
