import path from "node:path";
import type { ProjectLedgerEvent, ProjectOmoGoal, ProjectOmoLoop, ProjectWarning } from "./types.ts";
import { PROJECT_LIMITS, objectField, readSmallTextFile, relativeArtifactPath, textField, warning } from "./parser-utils.ts";
import { errorMessage } from "../types.ts";

function normalizeGoals(value: unknown): readonly ProjectOmoGoal[] {
  const record = objectField(value);
  const rawGoals: readonly unknown[] = Array.isArray(value) ? value : record && Array.isArray(record.goals) ? record.goals : [];
  return rawGoals.filter((goal): goal is Record<string, unknown> => objectField(goal) !== undefined).map((goal) => ({
    ...(textField(goal.id) === undefined ? {} : { id: textField(goal.id) }),
    ...(textField(goal.title) === undefined ? {} : { title: textField(goal.title) }),
    ...(textField(goal.objective) === undefined ? {} : { objective: textField(goal.objective) }),
    ...(textField(goal.status) === undefined ? {} : { status: textField(goal.status) }),
  }));
}

function goalStatusCounts(goals: readonly ProjectOmoGoal[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const goal of goals) {
    if (!goal.status) continue;
    counts[goal.status] = (counts[goal.status] ?? 0) + 1;
  }
  return counts;
}

function normalizeLedgerEvent(value: unknown): ProjectLedgerEvent | null {
  const record = objectField(value);
  if (!record) return null;
  const kind = textField(record.kind) ?? textField(record.type);
  const at = textField(record.at) ?? textField(record.createdAt) ?? textField(record.updatedAt);
  const message = textField(record.message) ?? textField(record.title) ?? textField(record.evidence);
  const goalId = textField(record.goalId) ?? textField(record.goal_id);
  if (!kind && !at && !message && !goalId) return null;
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(at === undefined ? {} : { at }),
    ...(message === undefined ? {} : { message }),
    ...(goalId === undefined ? {} : { goalId }),
  };
}

async function parseGoalsFile(root: string, loopDir: string, warnings: ProjectWarning[]): Promise<readonly ProjectOmoGoal[]> {
  const goalsPath = path.join(loopDir, "goals.json");
  const raw = await readSmallTextFile(root, goalsPath, warnings);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeGoals(parsed);
  } catch (error) {
    warnings.push(warning("goals_json_malformed", `goals.json could not be parsed: ${errorMessage(error)}`, relativeArtifactPath(root, goalsPath)));
    return [];
  }
}

async function parseLedgerFile(root: string, loopDir: string, warnings: ProjectWarning[]): Promise<{ readonly events: readonly ProjectLedgerEvent[]; readonly malformedLineCount: number }> {
  const ledgerPath = path.join(loopDir, "ledger.jsonl");
  const raw = await readSmallTextFile(root, ledgerPath, warnings);
  if (raw === null) return { events: [], malformedLineCount: 0 };

  const events: ProjectLedgerEvent[] = [];
  let malformedLineCount = 0;
  const relativePath = relativeArtifactPath(root, ledgerPath);
  for (const [index, line] of raw.split("\n").slice(0, PROJECT_LIMITS.maxLedgerLines).entries()) {
    if (line.trim().length === 0) continue;
    try {
      const event = normalizeLedgerEvent(JSON.parse(line));
      if (event) events.push(event);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      malformedLineCount += 1;
      warnings.push(warning("ledger_jsonl_malformed", `Malformed JSONL in ledger at line ${index + 1}`, relativePath));
    }
  }
  return {
    events: events.slice(-PROJECT_LIMITS.maxLedgerEvents),
    malformedLineCount,
  };
}

export async function parseOmoLoop(root: string, loopDir: string, warnings: ProjectWarning[]): Promise<ProjectOmoLoop> {
  const goals = await parseGoalsFile(root, loopDir, warnings);
  const ledger = await parseLedgerFile(root, loopDir, warnings);
  return {
    path: relativeArtifactPath(root, loopDir),
    loopId: path.basename(loopDir),
    goals,
    goalStatusCounts: goalStatusCounts(goals),
    ledgerEvents: ledger.events,
    malformedLedgerLineCount: ledger.malformedLineCount,
  };
}
