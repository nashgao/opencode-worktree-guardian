import type { GuardianConfig, GuardianToolInput } from "../types.ts";

export function buildInvisiblePolicy(config: GuardianConfig) {
  return [
    "Worktree Guardian policy:",
    "- Guardian auto-starts session worktree ownership eagerly by default; repo config autoStartMode=lazy delays ownership until the first mutation-triggering tool, and autoStart=false disables automatic ownership.",
    "- Do not run raw destructive git cleanup, reset, stash mutation, force-push, protected branches mutation, worktree removal, or rm -rf against worktrees.",
    "- Use guardian_goal for configured desired-state completion; it composes token-bound known-cleanable and verified empty-directory hygiene cleanup with guardian_done through existing gates.",
    "- After guardian_goal apply, inspect complete and hygienePostcondition. ok confirms authorized work ran, not that the desired state is complete. Strict no-unprotected-findings and no-unprotected-residue can return ok=true, complete=false, status=partial after the post-apply hygiene rescan.",
    "- goal.hygieneCompletion defaults to no-unprotected-residue. Guardian cleans only token-bound known-cleanable findings and filesystem-verified empty directories, then compares the selected session index with its recorded start commit and blocks before done on residual findings, unacknowledged tracked or untracked additions, or incomplete coverage. Pass exact current regular newly added files through one-shot token-bound intentionalPaths in both phases. protectedPaths deny deletion but do not acknowledge tracked additions. Explicit legacy modes remain available; no mode broadens deletion.",
    "- reviewableCandidates are inventory, not hygiene targets. For intentional reviewable cleanup, use guardian_delete_paths mode=plan paths=[...]; directories also require allowRecursive=true. Review target status and blockers before explicit confirmation, do not pass reviewables back to guardian_hygiene, and never run raw cleanup commands.",
    "- Finish normal Guardian work through guardian_done so Guardian can choose the safe lane; use guardian_finish only for explicit low-level session finishing.",
    "- Use guardian_status for read-only inspection, guardian_goal for desired-state completion, and guardian_done for normal gated completion.",
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
