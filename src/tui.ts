import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { openHud } from "./hud/Hud.tsx";

const COMMANDS = [
  {
    name: "guardian-done",
    title: "Guardian: Done",
    description: "Plan or apply the safest implementation-done path for the current repository state.",
    prompt: "Use the guardian_done native tool. Run mode=plan first. For an active session, apply only after explicit confirmation with confirm=true; if the session is dirty, include commitMessage so Guardian can commit before creating or reusing the PR, merging it, proving remote-base reachability, then removing the stale worktree and local branch. If it selects dirty primary-main publishing, require commitMessage and confirm=true; after publish, inspect the returned cleanupPlan and do not silently apply cleanup. Admin bypass requires allowAdminBypass=true. Never force-push, mutate stashes, delete remote branches, or run raw cleanup commands.",
  },
  {
    name: "guardian-status",
    title: "Guardian: Status",
    description: "Show Guardian session, worktree, branch, stash, and recovery inventory.",
    prompt: "Use the guardian_status native tool to inspect the current repository. Treat the result as read-only evidence.",
  },
  {
    name: "guardian-start",
    title: "Guardian: Start",
    description: "Create or attach this session to a Guardian-owned worktree.",
    prompt: "Use the guardian_start native tool to create or attach this session to a Guardian-owned worktree. Do not use raw git worktree add.",
  },
  {
    name: "guardian-finish",
    title: "Guardian: Finish",
    description: "Finish Guardian-owned work through the configured gated finish mode.",
    prompt: "Use the guardian_finish native tool for gated completion. Do not manually push, merge, clean, or remove worktrees. If dirty files block finish, distinguish allowedDirtyFiles from blockingDirtyFiles; narrow file-specific runtime paths can be allowed through repo config allowDirtyPaths, and allowed runtime dirt is left untouched.",
  },
  {
    name: "guardian-finish-workflow",
    title: "Guardian: Finish Workflow",
    description: "Plan or apply implementation-done cleanup for redundant merged worktrees and branches.",
    prompt: "Use the guardian_finish_workflow native tool. Run mode=plan first, inspect clean/synced preflight facts, cleanup candidates, blockers, and confirmToken, then apply only after explicit user confirmation with the fresh token. This workflow may remove only redundant merged Guardian worktrees and merged local branches through Guardian gates; it must not invent commits, merge protected branches, mutate stashes, run raw cleanup commands, or bypass guardian_finish/guardian_delete_worktree safety checks.",
  },
  {
    name: "guardian-preserve",
    title: "Guardian: Preserve",
    description: "Mark Guardian-owned work as terminal/preserved with a safety ref.",
    prompt: "Use the guardian_preserve native tool to mark the current Guardian-owned session as terminal/preserved with a safety ref. Preserved worktrees are cleanup-eligible; do not treat preservation as a reason to retain disk state forever.",
  },
  {
    name: "guardian-recover",
    title: "Guardian: Recover",
    description: "Inspect Guardian recovery refs, orphaned sessions, stashes, and evidence.",
    prompt: "Use the guardian_recover native tool for read-only recovery evidence. Do not mutate stashes, refs, worktrees, or files.",
  },
  {
    name: "guardian-report",
    title: "Guardian: Report",
    description: "Write a static offline Guardian HTML report.",
    prompt: "Use the guardian_report_html native tool to write the offline report, then return the report path and summarize the main risks.",
  },
  {
    name: "guardian-hygiene",
    title: "Guardian: Hygiene",
    description: "Scan, plan, or apply confirmed cleanup for workspace hygiene findings.",
    prompt: "Use the guardian_hygiene native tool. With no mode it scans only. For cleanup, run mode=plan first, inspect exact approved targets and blockers, get explicit user confirmation, then apply with confirmDelete=true. Never run raw cleanup commands.",
  },
  {
    name: "guardian-delete-worktree",
    title: "Guardian: Delete Worktree",
    description: "Plan or apply safe Guardian-mediated worktree, orphan branch, stale branch, or explicit unmerged abandon deletion.",
    prompt: "Use the guardian_delete_worktree native tool. Run mode=plan first unless a fresh confirmToken for the exact target/options is provided. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence. Never run raw worktree removal, filesystem deletion, forced branch deletion, hard reset, forced clean, or stash mutation.",
  },
  {
    name: "guardian-delete-paths",
    title: "Guardian: Delete Paths",
    description: "Plan or apply exact path deletion for approved files or directories.",
    prompt: "Use the guardian_delete_paths native tool. Run mode=plan first with exact paths, inspect target status and blockers, get explicit user confirmation, then apply with confirmDelete=true. Tracked source deletion requires allowTracked=true. Directory deletion requires allowRecursive=true. Use guardian_delete_worktree for worktree removal.",
  },
  {
    name: "guardian-unblock-finish",
    title: "Guardian: Unblock Finish",
    description: "Plan or apply safe Guardian finish blocker resolution.",
    prompt: "Use the guardian_unblock_finish native tool. Run mode=plan first unless a fresh confirmToken for the exact action is provided. Do not delete files, stash, clean, or commit source changes.",
  },
  {
    name: "guardian-gc",
    title: "Guardian: GC",
    description: "Plan or apply record-only Guardian state cleanup of stale terminal, poisoned, and orphaned session records.",
    prompt: "Use the guardian_gc native tool to prune stale Guardian session records. Run mode=plan first and inspect candidates (stale terminal, poisoned primary/protected, orphaned). Apply only after explicit user confirmation with confirmDelete=true and the returned confirmToken. It is record-only and never deletes git branches, worktrees, refs, stashes, or files.",
  },
] as const;

async function submitPrompt(api: TuiPluginApi, prompt: string) {
  const route = api.route.current;
  let sessionID: string | undefined;
  if (route.name === "session" && route.params && typeof route.params.sessionID === "string") {
    sessionID = route.params.sessionID;
  }
  if (!sessionID) {
    api.ui.toast({ variant: "warning", title: "Guardian", message: "Open a session before running Guardian commands." });
    return;
  }

  await api.client.session.promptAsync({
    sessionID,
    directory: api.state.path.directory,
    parts: [{ type: "text", text: prompt }],
  });
}

export async function tui(api: TuiPluginApi) {
  const promptCommands = COMMANDS.map((command) => ({
    namespace: "palette",
    name: command.name,
    title: command.title,
    desc: command.description,
    category: "Guardian",
    slashName: command.name,
    run: () => submitPrompt(api, command.prompt),
  }));
  api.keymap.registerLayer({
    commands: [
      ...promptCommands,
      {
        namespace: "palette",
        name: "guardian-hud",
        title: "Guardian: HUD",
        desc: "Open the live Guardian worktree HUD",
        category: "Guardian",
        slashName: "guardian-hud",
        run: () => openHud(api),
      },
    ],
    bindings: [],
  });
}

export const id = "opencode-worktree-guardian";

export default { id, tui };
