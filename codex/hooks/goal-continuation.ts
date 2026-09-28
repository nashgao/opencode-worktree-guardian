import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const CheckpointSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  repoId: z.string(),
  repoRoot: z.string(),
  status: z.string(),
  reason: z.string(),
  fingerprint: z.string(),
  seenFingerprints: z.array(z.string()),
  needsHuman: z.boolean(),
});

type Checkpoint = z.infer<typeof CheckpointSchema>;

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

function checkpointPath(sessionId: string): string {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  const stateHome = process.env["XDG_STATE_HOME"]?.trim() || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "opencode-worktree-guardian", "codex-goals", `${sessionKey}.json`);
}

async function readCheckpoint(sessionId: string): Promise<Checkpoint | null> {
  try {
    const parsed = CheckpointSchema.safeParse(JSON.parse(await fs.readFile(checkpointPath(sessionId), "utf8")));
    if (!parsed.success || parsed.data.sessionId !== sessionId) throw new Error("Guardian Goal continuation checkpoint is invalid");
    return parsed.data;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function writeCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
  const target = checkpointPath(sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function childResults(result: Record<string, unknown>): readonly Record<string, unknown>[] {
  const steps = Array.isArray(result["steps"]) ? result["steps"] : [];
  return steps.map((step) => record(step)).filter((step): step is Record<string, unknown> => step !== null)
    .map((step) => record(step["result"])).filter((step): step is Record<string, unknown> => step !== null);
}

function resultFingerprint(result: Record<string, unknown>): string {
  const summary = {
    status: result["status"],
    complete: result["complete"],
    blockers: result["blockers"],
    steps: childResults(result).map((child) => ({ status: child["status"], code: child["code"], reason: child["reason"] })),
  };
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex");
}

function needsHuman(result: Record<string, unknown>): boolean {
  return childResults(result).some((child) => child["code"] === "required-review" || child["status"] === "waiting");
}

export async function checkpointGoalResult(repoRoot: string, repoId: string, sessionId: string | undefined, args: Record<string, unknown>, result: Record<string, unknown>): Promise<void> {
  if (!sessionId) return;
  const existing = await readCheckpoint(sessionId);
  if (args["trackGoal"] === true && existing !== null && existing.repoId !== repoId) {
    throw new Error(`Codex session already tracks an unfinished Guardian Goal for ${existing.repoRoot}; finish or explicitly resolve it before tracking ${repoRoot}`);
  }
  if (args["trackGoal"] !== true && (existing === null || existing.repoId !== repoId)) return;
  const target = checkpointPath(sessionId);
  if (result["complete"] === true) {
    await fs.unlink(target).catch((error: unknown) => { if (!isEnoent(error)) throw error; });
    return;
  }
  const checkpoint: Checkpoint = {
    version: 1,
    sessionId,
    repoId,
    repoRoot,
    status: typeof result["status"] === "string" ? result["status"] : "unknown",
    reason: typeof result["reason"] === "string" ? result["reason"].slice(0, 300) : "",
    fingerprint: resultFingerprint(result),
    seenFingerprints: existing?.repoId === repoId ? existing.seenFingerprints : [],
    needsHuman: needsHuman(result),
  };
  await writeCheckpoint(sessionId, checkpoint);
}

export async function stopForPendingGoal(sessionId: string): Promise<string> {
  const checkpoint = await readCheckpoint(sessionId);
  if (!checkpoint || checkpoint.needsHuman || checkpoint.seenFingerprints.includes(checkpoint.fingerprint)) return "";
  await writeCheckpoint(sessionId, { ...checkpoint, seenFingerprints: [...checkpoint.seenFingerprints, checkpoint.fingerprint] });
  return `${JSON.stringify({ decision: "block", reason: `Guardian Goal remains incomplete for ${checkpoint.repoRoot}. Re-plan from current evidence and continue authorized safe steps. Stop only for an exact human decision, external wait, or unchanged blocker; never bypass a Guardian gate.` })}\n`;
}

export async function pendingGoalContext(sessionId: string): Promise<string> {
  const checkpoint = await readCheckpoint(sessionId);
  if (!checkpoint) return "";
  const detail = checkpoint.reason ? ` Last result: ${checkpoint.reason}` : "";
  return `An explicitly tracked Guardian Goal for ${checkpoint.repoRoot} remains ${checkpoint.status}.${detail} Re-plan from current evidence before any apply; this checkpoint does not authorize deletion, admin bypass, or stale-token reuse.`;
}
