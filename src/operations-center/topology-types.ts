export const TOPOLOGY_MODES = ["metro", "radar", "timeline", "gittree", "sunburst", "swimlanes", "terminal"] as const;
export type TopologyMode = typeof TOPOLOGY_MODES[number];
