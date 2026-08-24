import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectCleanupFingerprint } from "./deletion-fingerprint.ts";
import type { JournaledRecord } from "./quarantine-journal.ts";
import type { QuarantineItemRecordV1 } from "./quarantine-types.ts";
import { parseProvenanceRecord } from "./quarantine-types.ts";
import type { GuardianPaths, GuardianStateRecord } from "./types.ts";

type MetadataEntry = {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly digest?: string;
};

const ROOT_FILES = new Set(["state.json", "events.jsonl", "report.html", "project-report.html", "codex-plan-cache.json"]);
const ROOT_DIRECTORIES = new Set(["lock-tmp", "lock-tombstones", "provenance", "journal", "quarantine"]);
const STABILITY_EXCLUDED_ROOT_FILES = new Set(["codex-plan-cache.json"]);

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function collectTree(root: string): Promise<readonly MetadataEntry[]> {
  const inventory: MetadataEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      const relativePath = path.relative(root, target).split(path.sep).join("/");
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Guardian metadata contains a symlink: ${relativePath}`);
      if (stat.isDirectory()) {
        inventory.push({ path: relativePath, kind: "directory" });
        await visit(target);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Guardian metadata contains an unsupported entry: ${relativePath}`);
      const content = await fs.readFile(target);
      inventory.push({ path: relativePath, kind: "file", digest: crypto.createHash("sha256").update(content).digest("hex") });
    }
  }
  await visit(root);
  return inventory;
}

function entryMap(entries: readonly MetadataEntry[]): ReadonlyMap<string, MetadataEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function referencedProvenancePaths(state: GuardianStateRecord): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  for (const session of Object.values(state.sessions)) {
    const reference = session.provenance?.manifest;
    if (!reference) continue;
    const previous = references.get(reference.relativePath);
    if (previous && previous !== reference.digest) throw new Error(`conflicting Guardian provenance references: ${reference.relativePath}`);
    references.set(reference.relativePath, reference.digest);
  }
  return references;
}

function validateRoot(entries: readonly MetadataEntry[]): void {
  for (const entry of entries.filter((candidate) => !candidate.path.includes("/"))) {
    if (entry.path === "state.lock") throw new Error("legacy Guardian state.lock blocks clean-completion proof");
    if (ROOT_FILES.has(entry.path)) {
      if (entry.kind !== "file") throw new Error(`Guardian metadata root entry has the wrong kind: ${entry.path}`);
      continue;
    }
    if (ROOT_DIRECTORIES.has(entry.path)) {
      if (entry.kind !== "directory") throw new Error(`Guardian metadata root entry has the wrong kind: ${entry.path}`);
      continue;
    }
    throw new Error(`unknown Guardian metadata root entry: ${entry.path}`);
  }
}

function validateLockDirectories(entries: readonly MetadataEntry[]): void {
  const temporary = entries.find((entry) => entry.path.startsWith("lock-tmp/"));
  if (temporary) throw new Error(`orphan Guardian lock temporary entry: ${temporary.path}`);
  const tombstone = entries.find((entry) => entry.path.startsWith("lock-tombstones/"));
  if (tombstone) throw new Error(`ambiguous Guardian lock tombstone: ${tombstone.path}`);
}

async function validateProvenance(entries: readonly MetadataEntry[], state: GuardianStateRecord, paths: GuardianPaths): Promise<void> {
  const expected = referencedProvenancePaths(state);
  const actual = entries.filter((entry) => entry.path.startsWith("provenance/") && entry.path !== "provenance");
  for (const entry of actual) {
    const expectedDigest = expected.get(entry.path);
    if (entry.kind !== "file" || !expectedDigest) throw new Error(`unknown Guardian provenance entry: ${entry.path}`);
    if (entry.digest !== expectedDigest) throw new Error(`Guardian provenance manifest digest mismatch: ${entry.path}`);
    try {
      parseProvenanceRecord(JSON.parse(await fs.readFile(path.join(paths.dir, entry.path), "utf8")));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error(`Guardian provenance manifest is malformed or has an unsupported version: ${entry.path}`, { cause: error });
    }
  }
  const present = new Set(actual.map((entry) => entry.path));
  const missing = [...expected.keys()].find((entry) => !present.has(entry));
  if (missing) throw new Error(`missing referenced Guardian provenance manifest: ${missing}`);
}

function validateJournal(entries: readonly MetadataEntry[]): void {
  const unknown = entries.find((entry) => entry.path.startsWith("journal/")
    && entry.path !== "journal/items"
    && entry.path !== "journal/operations"
    && !entry.path.startsWith("journal/items/")
    && !entry.path.startsWith("journal/operations/"));
  if (unknown) throw new Error(`unknown Guardian journal entry: ${unknown.path}`);
  for (const root of ["journal/items", "journal/operations"]) {
    const entry = entries.find((candidate) => candidate.path === root);
    if (entry && entry.kind !== "directory") throw new Error(`Guardian journal root has the wrong kind: ${root}`);
  }
}

function artifactRelation(payloadRoot: string, artifactPath: string, candidatePath: string): boolean {
  const artifact = path.relative(payloadRoot, artifactPath).split(path.sep).join("/");
  const candidate = path.relative(payloadRoot, candidatePath).split(path.sep).join("/");
  return candidate === artifact || candidate.startsWith(`${artifact}/`) || artifact.startsWith(`${candidate}/`);
}

async function validateQuarantineItem(paths: GuardianPaths, entries: readonly MetadataEntry[], item: JournaledRecord<QuarantineItemRecordV1>): Promise<void> {
  const record = item.record;
  const itemRoot = path.join(paths.quarantineDir, "items", record.quarantineId);
  const payloadRoot = path.join(itemRoot, "payload");
  const expectedArtifact = path.resolve(payloadRoot, record.originalRelativePath);
  if (path.resolve(record.artifactPath) !== expectedArtifact) throw new Error(`Guardian quarantine artifact path identity mismatch: ${record.quarantineId}`);
  const itemPrefix = `quarantine/items/${record.quarantineId}/`;
  const unknown = entries.find((entry) => entry.path.startsWith(itemPrefix)
    && entry.path !== `${itemPrefix}payload`
    && !entry.path.startsWith(`${itemPrefix}payload/`));
  if (unknown) throw new Error(`unknown Guardian quarantine item entry: ${unknown.path}`);
  const payloadEntries = entries.filter((entry) => entry.path.startsWith(`${itemPrefix}payload/`));
  const unrelated = payloadEntries.find((entry) => !artifactRelation(payloadRoot, expectedArtifact, path.join(paths.dir, entry.path)));
  if (unrelated) throw new Error(`unknown Guardian quarantine payload entry: ${unrelated.path}`);
  if (record.state === "available") {
    const fingerprint = await collectCleanupFingerprint(payloadRoot, expectedArtifact);
    if (JSON.stringify(fingerprint) !== JSON.stringify(record.fingerprint)) throw new Error(`Guardian quarantine artifact fingerprint mismatch: ${record.quarantineId}`);
    return;
  }
  try {
    await fs.lstat(expectedArtifact);
    throw new Error(`terminal Guardian quarantine item still has an artifact: ${record.quarantineId}`);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

async function validateQuarantine(entries: readonly MetadataEntry[], paths: GuardianPaths, items: readonly JournaledRecord<QuarantineItemRecordV1>[]): Promise<void> {
  const allowedIds = new Set(items.map((item) => item.record.quarantineId));
  const itemDirectories = entries.filter((entry) => entry.kind === "directory" && /^quarantine\/items\/[^/]+$/.test(entry.path));
  const unknown = itemDirectories.find((entry) => !allowedIds.has(entry.path.slice("quarantine/items/".length)));
  if (unknown) throw new Error(`unknown Guardian quarantine item: ${unknown.path}`);
  const tombstone = entries.find((entry) => entry.path.startsWith("quarantine/tombstones/"));
  if (tombstone) throw new Error(`orphan Guardian quarantine tombstone: ${tombstone.path}`);
  for (const item of items) await validateQuarantineItem(paths, entries, item);
}

export async function guardianMetadataSnapshot(input: {
  readonly paths: GuardianPaths;
  readonly state: GuardianStateRecord;
  readonly quarantineItems: readonly JournaledRecord<QuarantineItemRecordV1>[];
}): Promise<{ readonly entries: readonly MetadataEntry[]; readonly reason?: string }> {
  try {
    const entries = await collectTree(input.paths.dir);
    validateRoot(entries);
    validateLockDirectories(entries);
    await validateProvenance(entries, input.state, input.paths);
    validateJournal(entries);
    await validateQuarantine(entries, input.paths, input.quarantineItems);
    return { entries: entries.filter((entry) => !STABILITY_EXCLUDED_ROOT_FILES.has(entry.path)) };
  } catch (error) {
    return { entries: [], reason: `Guardian metadata inventory failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
