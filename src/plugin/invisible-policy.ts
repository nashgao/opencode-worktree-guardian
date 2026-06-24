import type { GuardianConfig, GuardianToolInput } from "../types.ts";

export function buildInvisiblePolicy(config: GuardianConfig) {
  return [
    "Worktree Guardian policy:",
    "- Guardian auto-starts session worktree ownership eagerly by default; repo config autoStartMode=lazy delays ownership until the first mutation-triggering tool, and autoStart=false disables automatic ownership.",
    "- Do not run raw destructive git cleanup, reset, stash mutation, force-push, protected branches mutation, worktree removal, or rm -rf against worktrees.",
    "- Finish normal Guardian work through guardian_done so Guardian can choose the safe lane; use guardian_finish only for explicit low-level session finishing.",
    "- Use guardian_status for read-only inspection and guardian_done for normal gated completion.",
    "- Safe mutating shell/git tool calls for a recorded Guardian session are routed into that recorded worktree automatically.",
    `- Default finish mode is ${config.finishMode}; auto-finish is ${config.autoFinish ? "enabled by repo config" : "disabled"} unless repo config opts in.`,
  ].join("\n");
}

export function injectInvisiblePolicy(output: GuardianToolInput | null | undefined, config: GuardianConfig) {
  if (!output || typeof output !== "object") return false;
  const policy = buildInvisiblePolicy(config);
  if (Array.isArray(output.system)) {
    output.system.push(policy);
    return true;
  }
  if (typeof output.system === "string") {
    output.system = `${output.system}\n\n${policy}`;
    return true;
  }
  output.system = [policy];
  return true;
}
