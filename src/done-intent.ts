import crypto from "node:crypto";
import { collectIgnoredFileFingerprint } from "./deletion-fingerprint.ts";
import type { DeletionFingerprintEntry } from "./deletion-fingerprint.ts";
import { buildDirtySessionCommitCandidate } from "./done-land-clean-commit.ts";
import { dirtySnapshot } from "./done-primary-snapshot.ts";
import type { DirtySnapshot } from "./done-primary-snapshot.ts";
import { getIgnoredFiles, withGitArtifactSandbox } from "./git.ts";

export type DirtySessionDoneIntentInspection = {
  readonly snapshot: DirtySnapshot;
  readonly commitPaths: readonly string[];
  readonly ignoredFiles: readonly string[];
  readonly ignoredFileFingerprint: readonly DeletionFingerprintEntry[];
};

export type DirtySessionDoneIntent = DirtySessionDoneIntentInspection & {
  readonly sourceIndexTree: string;
  readonly candidateTree: string;
  readonly digest: string;
};

export type BuildDirtySessionDoneIntentInput = {
  readonly cwd: string;
  readonly worktreePath: string;
};

export class DoneIntentBuildError extends Error {
  readonly phase: "ignored-files" | "commit-candidate";

  constructor(phase: "ignored-files" | "commit-candidate", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DoneIntentBuildError";
    this.phase = phase;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new TypeError("done intent digest contains an unsupported value");
  return serialized;
}

function stableDigest(input: Omit<DirtySessionDoneIntent, "digest">): string {
  const material = {
    snapshot: {
      entries: input.snapshot.entries
        .map((entry) => ({ status: entry.status, path: entry.path, ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}) }))
        .sort((left, right) => compareText(`${left.status}\0${left.path}\0${left.sourcePath ?? ""}`, `${right.status}\0${right.path}\0${right.sourcePath ?? ""}`)),
      paths: [...input.snapshot.paths].sort(compareText),
      fingerprints: input.snapshot.fingerprints
        .map((fingerprint) => ({ path: fingerprint.path, kind: fingerprint.kind, size: fingerprint.size, hash: fingerprint.hash }))
        .sort((left, right) => compareText(`${left.path}\0${left.kind}`, `${right.path}\0${right.kind}`)),
    },
    commitPaths: [...input.commitPaths].sort(compareText),
    ignoredFiles: [...input.ignoredFiles].sort(compareText),
    ignoredFileFingerprint: [...input.ignoredFileFingerprint].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right))),
    sourceIndexTree: input.sourceIndexTree,
    candidateTree: input.candidateTree,
  };
  return crypto.createHash("sha256").update(canonicalJson(material)).digest("hex");
}

// Read-only: reports dirty/ignored file status without hashing or staging any content, so it
// never invokes a configured Git clean filter. Callers that must enforce commit policy (signing,
// hooks, clean filters) before any filter-triggering operation call this first, run their policy
// check on the result, and only then call buildDirtySessionDoneIntentFromInspection.
export async function inspectDirtySessionDoneIntent(input: BuildDirtySessionDoneIntentInput): Promise<DirtySessionDoneIntentInspection> {
  const snapshot = await dirtySnapshot(input.cwd, undefined, { optionalLocksDisabled: true });
  try {
    const ignoredFiles = await getIgnoredFiles(input.worktreePath, { optionalLocksDisabled: true });
    const ignoredFileFingerprint = await collectIgnoredFileFingerprint(input.worktreePath, ignoredFiles);
    return { snapshot, commitPaths: snapshot.paths, ignoredFiles, ignoredFileFingerprint };
  } catch (error) {
    throw new DoneIntentBuildError("ignored-files", error);
  }
}

// Builds the actual candidate tree from dirty files. This stages and hashes file content and can
// invoke a configured Git clean filter, so callers must only reach this after a commit-policy
// check on inspection.commitPaths has already approved proceeding.
export async function buildDirtySessionDoneIntentFromInspection(input: { readonly cwd: string; readonly inspection: DirtySessionDoneIntentInspection }): Promise<DirtySessionDoneIntent> {
  let candidate: Awaited<ReturnType<typeof buildDirtySessionCommitCandidate>>;
  try {
    candidate = await withGitArtifactSandbox(input.cwd, async (artifactSandbox) => buildDirtySessionCommitCandidate(input.cwd, input.inspection.commitPaths, { artifactSandbox }));
  } catch (error) {
    throw new DoneIntentBuildError("commit-candidate", error);
  }
  const intent = { ...input.inspection, ...candidate };
  return { ...intent, digest: stableDigest(intent) };
}

export async function buildDirtySessionDoneIntent(input: BuildDirtySessionDoneIntentInput): Promise<DirtySessionDoneIntent> {
  const inspection = await inspectDirtySessionDoneIntent(input);
  return buildDirtySessionDoneIntentFromInspection({ cwd: input.cwd, inspection });
}
