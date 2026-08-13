import type { OperationsCenterEvent, OperationsCenterWorktree } from "./model.ts";
import { TOPOLOGY_MODES, type TopologyMode } from "./topology-types.ts";

export type TopologyDisplayModel = {
  readonly modes: readonly TopologyMode[];
  readonly worktrees: readonly OperationsCenterWorktree[];
  readonly events: readonly OperationsCenterEvent[];
  readonly primaryWorktreeId: string | null;
  readonly edges: readonly { readonly from: string; readonly to: string; readonly verification: "unverified"; readonly label: "Unverified relationship" }[];
  readonly unavailable: { readonly timeline: string; readonly gitTree: string; readonly radar: string; readonly sunburst: string; readonly swimlanes: string };
};

export function buildTopologyDisplayModel(input: { readonly worktrees: readonly OperationsCenterWorktree[]; readonly observedEvents: readonly OperationsCenterEvent[] }): TopologyDisplayModel {
  const primary = input.worktrees.find((worktree) => worktree.flags.primary) ?? null;
  return {
    modes: TOPOLOGY_MODES,
    worktrees: input.worktrees,
    events: input.observedEvents,
    primaryWorktreeId: primary?.id ?? null,
    edges: primary ? input.worktrees.filter((worktree) => worktree.id !== primary.id).map((worktree) => ({ from: primary.id, to: worktree.id, verification: "unverified" as const, label: "Unverified relationship" as const })) : [],
    unavailable: {
      timeline: "Unavailable: only supplied observed event timestamps are shown; lifecycle intervals are not inferred.",
      gitTree: "Commit ancestry, parentage, branch point, and chronology are unavailable/unverified.",
      radar: "Radial placement is illustrative/arbitrary; staleness and lifecycle are unavailable without timestamps.",
      sunburst: "Angular ordering is illustrative/arbitrary; it does not represent ancestry or priority.",
      swimlanes: "Unavailable: only supplied observed events are shown; intervals are not inferred.",
    },
  };
}
