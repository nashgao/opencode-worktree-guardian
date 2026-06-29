import { execFile, type ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultRunTimeoutMs = 8 * 60 * 1000;
export const expectedToolNames = [
  "guardian_delete_paths",
  "guardian_delete_worktree",
  "guardian_done",
  "guardian_finish",
  "guardian_finish_workflow",
  "guardian_gc",
  "guardian_hygiene",
  "guardian_preserve",
  "guardian_project_status",
  "guardian_recover",
  "guardian_report_html",
  "guardian_start",
  "guardian_status",
  "guardian_unblock_finish",
] as const;
export const expectedSlashNames = [
  "guardian-delete-paths",
  "guardian-delete-worktree",
  "guardian-done",
  "guardian-finish",
  "guardian-finish-workflow",
  "guardian-gc",
  "guardian-hud",
  "guardian-hygiene",
  "guardian-preserve",
  "guardian-project-status",
  "guardian-recover",
  "guardian-report",
  "guardian-start",
  "guardian-status",
  "guardian-unblock-finish",
] as const;
export const expectedCodexSkillNames = [
  "guardian-delete-paths",
  "guardian-delete-worktree",
  "guardian-done",
  "guardian-finish",
  "guardian-finish-workflow",
  "guardian-gc",
  "guardian-hud",
  "guardian-hygiene",
  "guardian-preserve",
  "guardian-project-status",
  "guardian-recover",
  "guardian-report",
  "guardian-start",
  "guardian-status",
  "guardian-unblock-finish",
  "worktree-guardian",
] as const;
export const expectedCommandAssets = [
  "commands/done.md",
  "commands/delete-paths.md",
  "commands/delete-worktree.md",
  "commands/finish.md",
  "commands/finish-workflow.md",
  "commands/gc.md",
  "commands/hygiene.md",
  "commands/preserve.md",
  "commands/project-status.md",
  "commands/recover.md",
  "commands/report.md",
  "commands/start.md",
  "commands/status.md",
  "commands/unblock-finish.md",
] as const;
export const expectedCodexAdapterFiles = [
  "codex/.codex-plugin/plugin.json",
  "codex/hooks/guardian-hook.ts",
  "codex/hooks/hooks.json",
  ...expectedCodexSkillNames.map((skillName) => `codex/skills/${skillName}/SKILL.md`),
] as const;
export const expectedPackagedCommandTools = [
  ["done", "guardian_done"],
  ["delete-paths", "guardian_delete_paths"],
  ["delete-worktree", "guardian_delete_worktree"],
  ["finish", "guardian_finish"],
  ["finish-workflow", "guardian_finish_workflow"],
  ["gc", "guardian_gc"],
  ["hygiene", "guardian_hygiene"],
  ["preserve", "guardian_preserve"],
  ["project-status", "guardian_project_status"],
  ["recover", "guardian_recover"],
  ["report", "guardian_report_html"],
  ["start", "guardian_start"],
  ["status", "guardian_status"],
  ["unblock-finish", "guardian_unblock_finish"],
] as const;
export const expectedPackageExports = {
  ".": "./src/index.ts",
  "./codex": "./codex/hooks/guardian-hook.ts",
  "./server": "./src/index.ts",
  "./tui": "./src/tui.ts",
} as const;
export const expectedPackageFiles = ["CHANGELOG.md", "codex", "commands", "docs", "src", "scripts", "skills", "README.md", "LICENSE"] as const;
export const legacyHygieneCommandNameParts = ["hygiene", "cleanup"] as const;
export const publicDriftScanEntries = ["README.md", "docs", "commands", "skills", "codex", "src", "test", "package.json", "package-lock.json"] as const;

export type RunOptions = Omit<ExecFileOptions, "env"> & {
  readonly env?: NodeJS.ProcessEnv;
  readonly coverage?: "inherit" | "suppress";
};

const coverageEnvNames = ["NODE_V8_COVERAGE", "OPENCODE_WORKTREE_GUARDIAN_COVERAGE_RUN", "NODE_COMPILE_CACHE"] as const;

export async function run(command: string, args: readonly string[], options: RunOptions = {}) {
  const { coverage = "inherit", env: optionEnv, ...execOptions } = options;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...optionEnv,
  };
  if (coverage === "suppress") {
    for (const name of coverageEnvNames) env[name] = "";
  }
  const { stdout, stderr } = await execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: defaultRunTimeoutMs,
    killSignal: "SIGTERM",
    ...execOptions,
    env,
  });
  const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
  const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  return { stdout: stdoutText.trim(), stderr: stderrText.trim() };
}

export function sortedPackPaths(files: readonly { readonly path: string }[], prefix: string): string[] {
  return files
    .map((file) => file.path)
    .filter((filePath) => filePath.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export async function collectTextFilePaths(relativeEntries: readonly string[]): Promise<string[]> {
  const found: string[] = [];

  async function visit(relativePath: string): Promise<void> {
    const absolutePath = path.join(projectRoot, relativePath);
    const stats = await fs.stat(absolutePath);
    if (!stats.isDirectory()) {
      found.push(relativePath);
      return;
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      await visit(path.join(relativePath, entry.name));
    }
  }

  for (const relativeEntry of relativeEntries) await visit(relativeEntry);
  return found.sort((left, right) => left.localeCompare(right));
}

export function legacyHygieneReferences(): readonly string[] {
  return [
    legacyHygieneCommandNameParts.join("-"),
    ["guardian", ...legacyHygieneCommandNameParts].join("_"),
  ];
}

export async function findLegacyHygieneReferences(): Promise<string[]> {
  const files = await collectTextFilePaths(publicDriftScanEntries);
  const legacyReferences = legacyHygieneReferences();
  const matches: string[] = [];

  for (const file of files) {
    const content = await fs.readFile(path.join(projectRoot, file), "utf8");
    for (const legacyReference of legacyReferences) {
      if (content.includes(legacyReference)) matches.push(`${normalizeRelativePath(file)}: ${legacyReference}`);
    }
  }

  return matches;
}
