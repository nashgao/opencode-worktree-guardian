import fs from "node:fs/promises";
import path from "node:path";
import { collectCleanupFingerprint } from "./deletion-fingerprint.ts";
import type { DeletionFingerprintEntry } from "./deletion-fingerprint.ts";
import { assertNoSymlinkAncestors, isSameOrInside, lstatOrMissing } from "./filesystem-boundaries.ts";
import { ensureDurableDirectory, syncDirectory } from "./state-durable-file.ts";

export type CooperativeQuarantineMoveInput = {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly expectedFingerprint: readonly DeletionFingerprintEntry[];
};

// Node exposes no atomic no-replace rename (no renameat2/RENAME_NOREPLACE or macOS
// renameatx_np/RENAME_EXCL bridge), so a destination created after the last check can still
// race the actual fs.rename. This matches Guardian's documented cooperative concurrency
// boundary elsewhere: mediated against cooperative writers, not a hard guarantee against a
// hostile or uncooperative same-UID actor. Re-verify immediately before and after the rename,
// and on any ambiguous postcondition leave the journal at "prepared" rather than guessing.
export async function moveQuarantinePathCooperatively(input: CooperativeQuarantineMoveInput): Promise<void> {
  const source = path.resolve(input.sourcePath);
  const destination = path.resolve(input.destinationPath);
  const sourceRoot = path.resolve(input.sourceRoot);
  const destinationRoot = path.resolve(input.destinationRoot);
  const destinationParent = path.dirname(destination);

  if (!isSameOrInside(source, sourceRoot) || !isSameOrInside(destination, destinationRoot)) {
    throw new Error("quarantine move escapes its validated root");
  }

  await ensureDurableDirectory(destinationParent);
  await assertNoSymlinkAncestors(source, "quarantine source");
  await assertNoSymlinkAncestors(destination, "quarantine destination");

  const [sourceStat, destinationStat] = await Promise.all([lstatOrMissing(source), lstatOrMissing(destination)]);
  if (!sourceStat || (!sourceStat.isFile() && !sourceStat.isDirectory())) throw new Error("quarantine source is missing or unsupported");
  if (destinationStat) throw new Error("quarantine destination already exists");

  const sourceFingerprint = await collectCleanupFingerprint(sourceRoot, source);
  if (JSON.stringify(sourceFingerprint) !== JSON.stringify(input.expectedFingerprint)) throw new Error("quarantine source fingerprint drift");

  const [sourceDevice, destinationDevice] = await Promise.all([fs.stat(source).then((stat) => stat.dev), fs.stat(destinationParent).then((stat) => stat.dev)]);
  if (sourceDevice !== destinationDevice) throw new Error("EXDEV risk: source and destination are on different devices");

  await assertNoSymlinkAncestors(source, "quarantine source");
  await assertNoSymlinkAncestors(destination, "quarantine destination");
  if (await lstatOrMissing(destination)) throw new Error("quarantine destination appeared before rename");

  await fs.rename(source, destination);

  const [postSource, postDestination] = await Promise.all([lstatOrMissing(source), lstatOrMissing(destination)]);
  if (postSource || !postDestination || postDestination.isSymbolicLink()) throw new Error("quarantine rename postcondition is ambiguous; preserve journal at prepared");

  await assertNoSymlinkAncestors(destination, "quarantine destination");
  await syncDirectory(path.dirname(source));
  if (path.dirname(source) !== destinationParent) await syncDirectory(destinationParent);
}
