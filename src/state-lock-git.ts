import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { assertReferenceTransactionHookSafe, controlledGitEnvironment } from "./git-process.ts";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 30_000;
const durableConfig = ["-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync"] as const;

async function runDurableGit(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...durableConfig, ...args], {
    encoding: "utf8",
    env: controlledGitEnvironment(),
    maxBuffer: 10 * 1024 * 1024,
    timeout: gitTimeoutMs,
    killSignal: "SIGTERM",
  });
  return stdout.trim();
}

async function runDurableGitWithInput(repoRoot: string, args: readonly string[], input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, ...durableConfig, ...args], {
      env: controlledGitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: gitTimeoutMs,
      killSignal: "SIGTERM",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`git ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

export async function deriveNullObjectId(repoRoot: string): Promise<string> {
  const emptyObjectId = await runDurableGitWithInput(repoRoot, ["hash-object", "--stdin"], "");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(emptyObjectId)) throw new Error("Git returned an invalid object id while deriving the lock null OID");
  return "0".repeat(emptyObjectId.length);
}

export async function publishLockBlob(repoRoot: string, input: string): Promise<string> {
  const objectId = await runDurableGitWithInput(repoRoot, ["hash-object", "-w", "--stdin"], input);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) throw new Error("Git returned an invalid lock blob object id");
  await runDurableGit(repoRoot, ["cat-file", "-e", `${objectId}^{blob}`]);
  return objectId;
}

export async function compareAndSwapLockRef(input: { readonly repoRoot: string; readonly lockRef: string; readonly newObjectId: string; readonly expectedObjectId: string }): Promise<void> {
  await assertReferenceTransactionHookSafe(input.repoRoot);
  await runDurableGit(input.repoRoot, ["update-ref", "--no-deref", input.lockRef, input.newObjectId, input.expectedObjectId]);
}
