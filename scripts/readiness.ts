import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const authoredRoots = ["src", "test", "scripts"];
const forbiddenExtensions = new Set([".js", ".mjs", ".cjs"]);
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
      env: { ...process.env, CI: "true", GIT_TERMINAL_PROMPT: "0" },
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error: any) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    console.error(`\nReadiness command failed: ${label}`);
    process.exit(error.code || 1);
  }
}

console.log("\nReadiness checks passed.");
