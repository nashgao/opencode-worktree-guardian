import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRecordLike } from "./types.ts";

const execFileAsync = promisify(execFile);

type GhResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly stdout: string; readonly stderr: string; readonly message: string; readonly exitCode?: number };

export type PullRequestInfo = {
  readonly number: number;
  readonly url: string;
  readonly headRefName: string;
  readonly headRefOid: string | null;
};

function outputText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

function errorCodeValue(value: unknown): number | undefined {
  return isRecordLike(value) && typeof value.code === "number" ? value.code : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function runGh(repoRoot: string, args: readonly string[]): Promise<GhResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: isRecordLike(error) ? outputText(error.stdout) : "",
      stderr: isRecordLike(error) ? outputText(error.stderr) : "",
      message: errorMessage(error),
      ...(errorCodeValue(error) === undefined ? {} : { exitCode: errorCodeValue(error) }),
    };
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function pullRequestFromRecord(value: unknown): PullRequestInfo | null {
  if (!isRecordLike(value)) return null;
  if (typeof value.number !== "number" || typeof value.url !== "string" || typeof value.headRefName !== "string") return null;
  return {
    number: value.number,
    url: value.url,
    headRefName: value.headRefName,
    headRefOid: typeof value.headRefOid === "string" ? value.headRefOid : null,
  };
}

function parsePullRequestList(stdout: string): PullRequestInfo[] {
  const parsed = parseJson(stdout || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed.map(pullRequestFromRecord).filter((entry): entry is PullRequestInfo => entry !== null);
}

function parsePullRequest(stdout: string): PullRequestInfo | null {
  return pullRequestFromRecord(parseJson(stdout));
}

async function findOpenPullRequest(repoRoot: string, branch: string, baseBranch: string): Promise<{ readonly ok: true; readonly pr: PullRequestInfo | null } | { readonly ok: false; readonly result: Record<string, unknown> }> {
  const result = await runGh(repoRoot, ["pr", "list", "--head", branch, "--base", baseBranch, "--state", "open", "--json", "number,url,headRefName,headRefOid"]);
  if (!result.ok) {
    return {
      ok: false,
      result: { ok: false, status: "blocked", reason: "gh pr list failed", gh: result },
    };
  }
  return { ok: true, pr: parsePullRequestList(result.stdout).find((pr) => pr.headRefName === branch) ?? null };
}

async function createPullRequest(repoRoot: string, branch: string, baseBranch: string, sessionId: string): Promise<{ readonly ok: true; readonly pr: PullRequestInfo } | { readonly ok: false; readonly result: Record<string, unknown> }> {
  const created = await runGh(repoRoot, [
    "pr",
    "create",
    "--head",
    branch,
    "--base",
    baseBranch,
    "--title",
    branch,
    "--body",
    `Guardian session ${sessionId}`,
  ]);
  if (!created.ok) return { ok: false, result: { ok: false, status: "blocked", reason: "gh pr create failed", gh: created } };
  const url = created.stdout.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  if (!url) return { ok: false, result: { ok: false, status: "blocked", reason: "gh pr create did not return a PR URL", gh: created } };
  const viewed = await runGh(repoRoot, ["pr", "view", url, "--json", "number,url,headRefName,headRefOid"]);
  if (!viewed.ok) return { ok: false, result: { ok: false, status: "blocked", reason: "gh pr view failed after create", prUrl: url, gh: viewed } };
  const pr = parsePullRequest(viewed.stdout);
  if (!pr) return { ok: false, result: { ok: false, status: "blocked", reason: "gh pr view returned an unexpected shape", prUrl: url, stdout: viewed.stdout } };
  return { ok: true, pr };
}

export async function getOrCreatePullRequest(repoRoot: string, branch: string, baseBranch: string, sessionId: string): Promise<{ readonly ok: true; readonly pr: PullRequestInfo; readonly created: boolean } | { readonly ok: false; readonly result: Record<string, unknown> }> {
  const existing = await findOpenPullRequest(repoRoot, branch, baseBranch);
  if (!existing.ok) return existing;
  if (existing.pr) return { ok: true, pr: existing.pr, created: false };
  const created = await createPullRequest(repoRoot, branch, baseBranch, sessionId);
  if (!created.ok) return created;
  return { ok: true, pr: created.pr, created: true };
}

export async function mergePullRequest(repoRoot: string, pr: PullRequestInfo, head: string, allowAdminBypass: boolean): Promise<{ readonly ok: true } | { readonly ok: false; readonly result: Record<string, unknown> }> {
  const args = ["pr", "merge", String(pr.number), "--merge", "--match-head-commit", head];
  if (allowAdminBypass) args.push("--admin");
  const merged = await runGh(repoRoot, args);
  if (merged.ok) return { ok: true };
  return {
    ok: false,
    result: {
      ok: false,
      status: allowAdminBypass ? "blocked" : "waiting",
      reason: "gh pr merge did not complete; Guardian will not clean up until the PR is landed",
      pr,
      gh: merged,
      adminBypass: allowAdminBypass,
    },
  };
}
