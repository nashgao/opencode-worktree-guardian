import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const authoredRoots = ["src", "test", "scripts"];
const forbiddenExtensions = new Set([".js", ".mjs", ".cjs"]);
const commandTimeoutMs = 10 * 60 * 1000;
const commands: Array<[string, string[]]> = [
  ["npm", ["run", "verify"]],
  ["npm", ["run", "audit:deps"]],
  ["npm", ["run", "test:contract"]],
  ["npm", ["run", "test:smoke:package"]],
  ["npm", ["run", "test:smoke:host"]],
  ["npm", ["pack", "--dry-run", "--json"]],
];

async function collectForbiddenAuthoredFiles(root: string) {
  const found: string[] = [];
  async function visit(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (forbiddenExtensions.has(path.extname(entry.name))) found.push(fullPath);
    }
  }

  for (const authoredRoot of authoredRoots) await visit(path.join(root, authoredRoot));
  return found;
}

const forbiddenAuthoredFiles = await collectForbiddenAuthoredFiles(process.cwd());
if (forbiddenAuthoredFiles.length) {
  console.error("Authored JavaScript files are not allowed:");
  for (const file of forbiddenAuthoredFiles) console.error(`- ${path.relative(process.cwd(), file)}`);
  process.exit(1);
}

for (const [command, args] of commands) {
  const label = [command, ...args].join(" ");
  process.stdout.write(`\n> ${label}\n`);
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 30 * 1024 * 1024,
      timeout: commandTimeoutMs,
      killSignal: "SIGTERM",
      env: { ...process.env, CI: "true", GIT_TERMINAL_PROMPT: "0" },
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error: unknown) {
    const commandError = error as { stdout?: string; stderr?: string; code?: number | string | null; signal?: NodeJS.Signals | null; killed?: boolean };
    if (commandError.stdout) process.stdout.write(commandError.stdout);
    if (commandError.stderr) process.stderr.write(commandError.stderr);
    if (commandError.killed || commandError.signal === "SIGTERM") {
      console.error(`\nReadiness command timed out after ${commandTimeoutMs}ms: ${label}`);
      process.exit(124);
    }
    console.error(`\nReadiness command failed: ${label}`);
    process.exit(typeof commandError.code === "number" ? commandError.code : 1);
  }
}

console.log("\nReadiness checks passed.");
