import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertReferenceTransactionHookSafe, controlledGitEnvironment, GUARDIAN_SUBPROCESS_TIMEOUT_MS } from "./git-process.ts";
import { isRecordLike } from "./types.ts";
import type { GuardianPullRequestMergeMethod } from "./types.ts";

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

type MergePullRequestInput = {
  readonly repoRoot: string;
  readonly pr: PullRequestInfo;
  readonly head: string;
  readonly allowAdminBypass: boolean;
  readonly pullRequestMergeMethod: GuardianPullRequestMergeMethod;
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
      timeout: GUARDIAN_SUBPROCESS_TIMEOUT_MS,
      killSignal: "SIGTERM",
      env: controlledGitEnvironment(),
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
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

export async function mergePullRequest(input: MergePullRequestInput): Promise<{ readonly ok: true } | { readonly ok: false; readonly result: Record<string, unknown> }> {
  try {
    await assertReferenceTransactionHookSafe(input.repoRoot);
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        status: "blocked",
        reason: "Guardian refuses PR merge while the reference-transaction policy is indeterminate or executable",
        pr: input.pr,
        error: errorMessage(error),
      },
    };
  }
  const args = ["pr", "merge", String(input.pr.number), `--${input.pullRequestMergeMethod}`, "--match-head-commit", input.head];
  if (input.allowAdminBypass) args.push("--admin");
  const merged = await runGh(input.repoRoot, args);
  if (merged.ok) return { ok: true };
  const explicitReviewError = /\breview required\b|\bapproving reviews? (?:is|are) required\b|\brequired approving reviews?\b/i.test(merged.stderr);
  let review: Record<string, unknown> | undefined;
  let reviewProbe: GhResult | undefined;
  let reviewProbeError: string | undefined;
  if (!explicitReviewError) {
    reviewProbe = await runGh(input.repoRoot, ["pr", "view", String(input.pr.number), "--json", "number,url,headRefOid,reviewDecision"]);
    if (reviewProbe.ok) {
      try {
        const parsed = parseJson(reviewProbe.stdout);
        if (isRecordLike(parsed) && parsed.number === input.pr.number && parsed.headRefOid === input.head && parsed.reviewDecision === "REVIEW_REQUIRED") {
          review = { number: parsed.number, url: parsed.url, headRefOid: parsed.headRefOid, reviewDecision: parsed.reviewDecision };
        }
      } catch {
        reviewProbeError = "gh pr view returned invalid review data";
      }
    } else {
      reviewProbeError = "gh pr view failed while checking review requirements";
    }
  }
  if (explicitReviewError || review !== undefined) {
    return {
      ok: false,
      result: {
        ok: false,
        status: input.allowAdminBypass ? "blocked" : "waiting",
        code: "required-review",
        reason: "PR merge requires an approving review; Guardian preserved the session and will not bypass branch protection",
        nextAction: "Arrange an eligible approving review or an authorized review-policy change, then rerun guardian_done",
        pr: input.pr,
        head: input.head,
        gh: merged,
        ...(review === undefined ? {} : { review }),
        ...(reviewProbe === undefined ? {} : { reviewProbe }),
        adminBypass: input.allowAdminBypass,
        pullRequestMergeMethod: input.pullRequestMergeMethod,
      },
    };
  }
  return {
    ok: false,
    result: {
      ok: false,
      status: input.allowAdminBypass ? "blocked" : "waiting",
      reason: `gh pr merge did not complete; Guardian will not clean up until the PR is landed${reviewProbeError === undefined ? "" : `; ${reviewProbeError}`}`,
      pr: input.pr,
      gh: merged,
      ...(reviewProbe === undefined ? {} : { reviewProbe }),
      adminBypass: input.allowAdminBypass,
      pullRequestMergeMethod: input.pullRequestMergeMethod,
    },
  };
}
