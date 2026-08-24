type GuardianTuiCommand = {
  readonly namespace: string;
  readonly name: string;
  readonly title: string;
  readonly desc: string;
  readonly category: string;
  readonly slashName: string;
  readonly run: () => void | Promise<void>;
};

export type GuardianTuiApi = {
  readonly state: {
    readonly path: {
      readonly directory: string;
    };
  };
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
  readonly ui: {
    readonly toast: (input: { readonly variant?: "info" | "success" | "warning" | "error"; readonly title?: string; readonly message: string }) => void;
  };
};

const COMMANDS = [
  {
    name: "guardian-done",
    title: "Guardian: Done",
    description: "Plan or apply the safest implementation-done path for the current repository state.",
    prompt: "Use the guardian_done native tool. Run mode=plan first, inspect selectedTarget, lane, preflight, dirty files, blockers, and cleanup preview, then continue to mode=apply confirm=true with the same options when the plan is safe and the user invoked the completion workflow. Guardian inventories the primary worktree plus active Guardian sessions, so the command can run from any cwd. Bare guardian_done auto-selects exactly one dirty implementation target; if multiple dirty targets exist, stop on needs-selection and rerun the exact primary=true, sessionId=..., or branch=... option shown. Use explicit primary=true, sessionId=..., or branch=... when the target is known. Terminal reattach and stale cleanup are plan-only handoffs: the old terminal id is metadata, and apply must show pending-to-active proof before treating a recovered session as active. Treat absent empty-lease reconciliation as native evidence, not cleanup authority. If native metadata reports advanced state-only retirement, preserve the branch/proof or report pending proof absent; do no sync, postflight, or deletion, and require a fresh plan. Active-session dirt and dirty primary-main publishing require commitMessage. Clean active sessions use done-all; apply lands finishable sessions, syncs local base from its tracked upstream when that upstream remote is trusted, cleans safe redundant candidates, may recoverably abandon Guardian-owned stale local branch-only leftovers with terminal-state or safety-ref proof, and reports remaining blockers. After session land or primary publish, inspect cleanupSweep. Admin bypass requires allowAdminBypass=true. Never force-push, mutate stashes, delete unrelated remote branches, or run raw cleanup commands.",
  },
  {
    name: "guardian-goal",
    title: "Guardian: Goal",
    description: "Drive the repo toward the configured Guardian desired end state.",
    prompt: "Use the guardian_goal native tool. Run mode=plan first, inspect the configured goal flags, hygiene and done child steps, blockers, selected commit target, complete, and hygienePostcondition, then continue to mode=apply confirm=true with the same options when the plan is safe and the user invoked the goal workflow. Strict actionable plans can be planned-partial with complete=null. If metadata says freshPlanRequired, stop and obtain the fresh plan rather than applying a prior one. Include commitMessage when dirty implementation work needs to be committed. Guardian goal composes token-bound known-cleanable hygiene cleanup before guardian_done so generated cache residue is not committed, then lands/pushes/cleans through existing Guardian gates. After apply, do not treat ok as desired-state completion: inspect complete and hygienePostcondition. no-unprotected-findings can return ok=true, complete=false, status=partial after the post-apply hygiene rescan when residual findings remain; in that mode, reviewableCandidates are inventory rather than strict failures. no-unprotected-residue additionally blocks unresolved reviewableCandidates and incomplete inventory coverage. Strict mode does not broaden deletion. Every mode auto-deletes only token-bound known-cleanable findings; residual nested-git and suspicious findings require direct explicit review, dirty nested Git requires allowDirtyNestedGit, and protectedPaths are intentional retention. Resolve reviewables by protecting intentional paths, moving retained evidence under a protected path, or exact guardian_delete_paths planning. Do not use raw git cleanup, raw worktree removal, raw branch deletion, stash mutation, force-push, or bypass Guardian blockers.",
  },
  {
    name: "guardian-status",
    title: "Guardian: Status",
    description: "Show Guardian session, worktree, branch, stash, and recovery inventory.",
    prompt: "Use the guardian_status native tool to inspect the current repository. Treat the result as read-only evidence within its bounded operational scope, not a repository-wide cleanliness claim. Additional secondary remotes are names-only unscanned secondary remotes unless native metadata selects one as the effective authority. Terminal reattach and stale cleanup are plan-only handoffs; use the native output and a fresh plan rather than changing state here.",
  },
  {
    name: "guardian-start",
    title: "Guardian: Start",
    description: "Create or attach this session to a Guardian-owned worktree.",
    prompt: "Use the guardian_start native tool to create or attach this session to a Guardian-owned worktree. Do not use raw git worktree add.",
  },
  {
    name: "guardian-init",
    title: "Guardian: Init",
    description: "Write the default repo-local Guardian config if it is missing.",
    prompt: "Use the guardian_init native tool to write the default .opencode/worktree-guardian.json config only if it is missing. Do not create sessions, worktrees, branches, or cleanup anything.",
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
    prompt: "Use the guardian_finish_workflow native tool. Run mode=plan first, inspect clean/synced preflight facts, cleanup candidates, blockers, and confirmToken, then apply only after explicit user confirmation with mode=apply confirm=true and the fresh token. Its bounded operational scope scans only the resolved effective remote; other configured/trusted remotes are names-only unscanned secondary remotes. If metadata says freshPlanRequired, do not reuse the prior plan. This workflow may remove redundant merged Guardian worktrees and ownership-proven local stale branches through Guardian gates with exact expected-head local ref deletion, plus token-bound merged remote Guardian refs from the resolved effective remote using expected-head leases; it must not invent commits, merge protected branches, mutate stashes, run raw cleanup commands, or bypass guardian_finish/guardian_delete_worktree safety checks.",
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
    name: "guardian-quarantine",
    title: "Guardian: Quarantine",
    description: "Plan a selected restore or permanent purge for one retained quarantine item.",
    prompt: "Use the guardian_quarantine native tool. Run mode=plan first with one exact action=restore|purge and quarantineId. Restore defaults to its original worktree only while registered; otherwise inspect eligibleTargetWorktreePaths and choose an exact registered targetWorktreePath. Apply restore only after explicit user confirmation with confirm=true. Purge is permanent and applies only after explicit user confirmation with confirmDelete=true. Never use raw move or deletion commands for quarantine artifacts, and do not ask the user to copy an internal confirm token.",
  },
  {
    name: "guardian-recover",
    title: "Guardian: Recover",
    description: "Inspect Guardian recovery refs, orphaned sessions, stashes, and evidence.",
    prompt: "Use the guardian_recover native tool for read-only recovery evidence. Terminal reattach and stale cleanup are plan-only handoffs: inspect native pending-to-active proof or absent empty-lease reconciliation, then obtain a fresh plan before any separate tool acts. Do not mutate stashes, refs, worktrees, or files.",
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
    prompt: "Use the guardian_hygiene native tool. With no mode it scans only. reviewableCandidates are inventory, not hygiene targets. For intentional reviewable cleanup, use guardian_delete_paths mode=plan paths=[...]; directories also require allowRecursive=true. Review target status and blockers before explicit confirmation, and do not pass reviewables back to guardian_hygiene. For hygiene findings, run mode=plan first, inspect exact approved targets and blockers, get explicit user confirmation, then apply with confirmDelete=true. Never run raw cleanup commands.",
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
        desc: "Guardian HUD is temporarily unavailable. Use /guardian-status instead.",
        category: "Guardian",
        slashName: "guardian-hud",
        run: () => api.ui.toast({ variant: "warning", title: "Guardian HUD unavailable", message: "The visual Guardian HUD is temporarily unavailable. Use /guardian-status instead." }),
      },
    ],
    bindings: [],
  });
}

export const id = "opencode-worktree-guardian";

export default { id, tui };
