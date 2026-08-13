import type { OperationsCenterActionId } from "./model.ts";

export type ActionGuidance = {
  readonly id: OperationsCenterActionId;
  readonly title: string;
  readonly instruction: string;
};

export function actionGuidance(input: { readonly id: OperationsCenterActionId; readonly path: string }): ActionGuidance {
  const selectedPath = input.path || "the selected worktree path";
  switch (input.id) {
    case "add": return { id: input.id, title: "Add worktree", instruction: "Use guardian_start createWorktree=true in an OpenCode session. This report does not create worktrees." };
    case "sync": return { id: input.id, title: "Plan sync", instruction: "Use guardian_goal mode=plan to inspect the configured desired-state plan. This report does not sync worktrees." };
    case "fetch": return { id: input.id, title: "Refresh evidence", instruction: "Use guardian_status for current cached read-only evidence. This cached report is a snapshot and does not fetch." };
    case "pull": return { id: input.id, title: "Review current state", instruction: "Use guardian_status for current cached read-only evidence. This cached report is a snapshot and does not pull." };
    case "switch": return { id: input.id, title: "Open selected worktree", instruction: `Selected path: ${selectedPath}. Open an OpenCode session at that path, then use guardian_status. This report does not switch worktrees.` };
    case "open": return { id: input.id, title: "Open selected path", instruction: `Selected path: ${selectedPath}. Open an OpenCode session at that path, then use guardian_status. This report does not open folders.` };
    case "terminal": return { id: input.id, title: "Open a session terminal", instruction: `Selected path: ${selectedPath}. Open an OpenCode session at that path, then use guardian_status. This report does not open terminals.` };
    case "remove": return { id: input.id, title: "Plan worktree removal", instruction: `Review guardian_delete_worktree mode=plan targetPath=${JSON.stringify(selectedPath)} in an OpenCode session. This report does not remove worktrees.` };
  }
}
