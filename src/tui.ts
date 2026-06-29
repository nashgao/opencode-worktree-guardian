import { openHud } from "./hud/Hud.tsx";
import type { GuardianHudApi } from "./hud/Hud.tsx";

type GuardianTuiCommand = {
  readonly namespace: string;
  readonly name: string;
  readonly title: string;
  readonly desc: string;
  readonly category: string;
  readonly slashName: string;
  readonly run: () => void | Promise<void>;
};

export type GuardianTuiApi = GuardianHudApi & {
  readonly keymap: {
    readonly registerLayer: (input: { readonly commands: readonly GuardianTuiCommand[]; readonly bindings: readonly unknown[] }) => unknown;
  };
  readonly route: {
    readonly current: { readonly name: string; readonly params?: Record<string, unknown> };
  };
  readonly client: {
    readonly session: {
      readonly promptAsync: (input: { readonly sessionID: string; readonly directory: string; readonly parts: readonly { readonly type: "text"; readonly text: string }[] }) => Promise<void>;
    };
  };
  readonly ui: GuardianHudApi["ui"] & {
    readonly toast: (input: { readonly variant?: "info" | "success" | "warning" | "error"; readonly title?: string; readonly message: string }) => void;
  };
};

const COMMANDS = [
  {
    name: "guardian-done",
    title: "Guardian: Done",
    description: "Plan or apply the safest implementation-done path for the current repository state.",
    prompt: "Use the guardian_done native tool. Run mode=plan first, inspect selectedTarget, lane, preflight, dirty files, blockers, and cleanup preview, then continue to mode=apply confirm=true with the same options when the plan is safe and the user invoked the completion workflow. Guardian inventories the primary worktree plus active Guardian sessions, so the command can run from any cwd. Bare guardian_done auto-selects exactly one dirty implementation target; if multiple dirty targets exist, stop on needs-selection and rerun the exact primary=true, sessionId=..., or branch=... option shown. Use explicit primary=true, sessionId=..., or branch=... when the target is known. Active-session dirt and dirty primary-main publishing require commitMessage. Clean active sessions use done-all; apply lands finishable sessions, syncs local base from its tracked upstream when that upstream remote is trusted, and cleans safe redundant candidates while reporting remaining blockers. After session land or primary publish, inspect cleanupSweep. Admin bypass requires allowAdminBypass=true. Never force-push, mutate stashes, delete unrelated remote branches, or run raw cleanup commands.",
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
    prompt: "Use the guardian_finish_workflow native tool. Run mode=plan first, inspect clean/synced preflight facts, cleanup candidates, blockers, and confirmToken, then apply only after explicit user confirmation with the fresh token. This workflow may remove redundant merged Guardian worktrees and ownership-proven local stale branches through Guardian gates with exact expected-head local ref deletion, plus token-bound merged remote Guardian refs from the resolved effective remote using expected-head leases; it must not invent commits, merge protected branches, mutate stashes, run raw cleanup commands, or bypass guardian_finish/guardian_delete_worktree safety checks.",
  },
  {
    name: "guardian-preserve",
    title: "Guardian: Preserve",
    description: "Mark Guardian-owned work as terminal/preserved with a safety ref.",
    prompt: "Use the guardian_preserve native tool to mark the current Guardian-owned session as terminal/preserved with a safety ref. Preserved worktrees are cleanup-eligible; do not treat preservation as a reason to retain disk state forever.",
  },
  {
    name: "guardian-project-status",
    title: "Guardian: Project Status",
    description: "Inspect project roadmap, milestone, plan, and ULW evidence.",
    prompt: "Use the guardian_project_status native tool to inspect project roadmap, milestone, plan, and ULW evidence. Treat the result as read-only evidence unless writeReport=true is explicitly requested.",
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
    prompt: "Use the guardian_delete_worktree native tool. Run mode=plan first unless a fresh confirmToken for the exact target/options is provided. Dirty targets block by default; use allowRedundantDirtyPaths=true only in direct plan/apply when Guardian proves each dirty path already matches the fetched base tree and reports dirtySnapshotRef. Stale local Guardian branch cleanup requires an exact branch or terminal sessionId plus deleteBranch=true and Guardian ownership proof from terminal state or safety refs. Intentional unmerged local abandonment requires deleteBranch=true plus abandonUnmerged=true in both plan and apply after inspecting unmerged commit evidence. Never run raw worktree removal, filesystem deletion, forced branch deletion, hard reset, forced clean, or stash mutation.",
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

async function submitPrompt(api: GuardianTuiApi, prompt: string) {
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

export async function tui(api: GuardianTuiApi) {
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
