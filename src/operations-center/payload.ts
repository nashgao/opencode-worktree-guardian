import { actionGuidance } from "./guidance.ts";
import type { OperationsCenterModel } from "./model.ts";

type GuidanceSelection = {
  readonly worktreeId: string | null;
  readonly path: string;
  readonly actions: readonly ReturnType<typeof actionGuidance>[];
};

export type OperationsCenterPayload = {
  readonly model: OperationsCenterModel;
  readonly guidance: {
    readonly fallback: GuidanceSelection;
    readonly worktrees: readonly GuidanceSelection[];
  };
};

function selection(model: OperationsCenterModel, path: string, worktreeId: string | null): GuidanceSelection {
  return { worktreeId, path, actions: model.actions.map((action) => actionGuidance({ id: action.id, path })) };
}

export function buildOperationsCenterPayload(model: OperationsCenterModel): OperationsCenterPayload {
  return {
    model,
    guidance: {
      fallback: selection(model, "the selected worktree path", null),
      worktrees: model.worktrees.map((worktree) => selection(model, worktree.path, worktree.id)),
    },
  };
}
