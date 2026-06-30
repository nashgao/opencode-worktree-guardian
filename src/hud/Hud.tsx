/** @jsxImportSource @opentui/solid */
import { createResource, For, Show } from "solid-js";
import type { RGBA } from "@opentui/core";
import { guardianStatus } from "../recover.ts";
import { buildHudModel, type HudModel, type HudTone, type HudWorktree } from "./model.ts";

export type HudColor = RGBA | string;

export type HudColors = {
  readonly text: HudColor;
  readonly muted: HudColor;
  readonly good: HudColor;
  readonly warn: HudColor;
  readonly bad: HudColor;
  readonly accent: HudColor;
  readonly border: HudColor;
};

export type GuardianHudApi = {
  readonly state: {
    readonly path: {
      readonly directory: string;
    };
  };
  readonly theme: {
    readonly current: {
      readonly text: HudColor;
      readonly textMuted: HudColor;
      readonly success: HudColor;
      readonly warning: HudColor;
      readonly error: HudColor;
      readonly accent: HudColor;
      readonly border: HudColor;
    };
  };
  readonly ui: {
    readonly dialog: {
      readonly setSize: (size: "medium" | "large" | "xlarge") => void;
      readonly replace: (render: () => unknown, onClose?: () => void) => void;
    };
  };
};

function toneColor(tone: HudTone, colors: HudColors): HudColor {
  if (tone === "good") return colors.good;
  if (tone === "warn") return colors.warn;
  if (tone === "bad") return colors.bad;
  return colors.muted;
}

function worktreeLine(worktree: HudWorktree): string {
  const marker = worktree.isPrimary ? "● " : "├ ";
  const session = worktree.session ? `  ${worktree.session.status} refs:${worktree.session.safetyRefCount}` : "";
  const markers = worktree.markers.length > 0 ? `  (${worktree.markers.join(",")})` : "";
  const flags = worktree.flags.length > 0 ? `  [${worktree.flags.join(",")}]` : "";
  return `${marker}${worktree.relPath}  ${worktree.branch}  ${worktree.head}${session}${markers}${flags}`;
}

const METRIC_ABBR: Record<string, string> = {
  Worktrees: "wt",
  Active: "active",
  Terminal: "term",
  Orphaned: "orphan",
  "Safety Refs": "refs",
  Dirty: "dirty",
  Stashes: "stash",
  Hygiene: "hyg",
};

function metricsLine(metrics: HudModel["metrics"]): string {
  return metrics.map((metric) => `${METRIC_ABBR[metric.label] ?? metric.label}:${metric.value}`).join("  ");
}

function shortRepoPath(repoRoot: string): string {
  const segments = repoRoot.split("/").filter((segment) => segment.length > 0);
  return segments.length <= 2 ? repoRoot : `…/${segments.slice(-2).join("/")}`;
}

// Pure, api-free view. Rendered both inside OpenCode (via Hud) and standalone
// (via the preview harness), so it must depend only on a model + a color map.
export function HudView(props: { readonly model: HudModel; readonly colors: HudColors }) {
  const model = () => props.model;
  const colors = () => props.colors;
  return (
    <box flexDirection="column" padding={1} gap={1} border borderColor={colors().border}>
      <text fg={colors().accent}>{`Guardian HUD · ${shortRepoPath(model().repoRoot)}`}</text>
      <text fg={toneColor(model().verdict.tone, colors())}>{model().verdict.headline}</text>
      <Show when={model().verdict.nextAction}>
        {(next) => <text fg={colors().muted}>{`→ ${next()}`}</text>}
      </Show>
      <text fg={colors().muted}>{metricsLine(model().metrics)}</text>
      <text fg={colors().text}>{"Worktrees"}</text>
      <For each={model().worktrees}>
        {(worktree) => <text fg={toneColor(worktree.tone, colors())}>{worktreeLine(worktree)}</text>}
      </For>
      <Show when={model().branchesWithoutWorktree.length > 0}>
        <text fg={colors().muted}>{`branches w/o worktree: ${model().branchesWithoutWorktree.map((branch) => branch.name).join(", ")}`}</text>
      </Show>
      <Show when={model().risks.length > 0} fallback={<text fg={colors().good}>{"no risks detected"}</text>}>
        <text fg={colors().warn}>{"Risks"}</text>
        <For each={model().risks}>
          {(risk) => (
            <text fg={risk.severity === "fail" ? colors().bad : colors().warn}>{`${risk.severity}  ${risk.label} — ${risk.detail}`}</text>
          )}
        </For>
      </Show>
    </box>
  );
}

function themeColors(api: GuardianHudApi): HudColors {
  const theme = api.theme.current;
  return {
    text: theme.text,
    muted: theme.textMuted,
    good: theme.success,
    warn: theme.warning,
    bad: theme.error,
    accent: theme.accent,
    border: theme.border,
  };
}

// OpenCode-wired HUD: pulls live Guardian state for the current directory and
// renders HudView. guardianStatus() reads git + state from disk with a cwd, so
// it works directly in the TUI process.
export function Hud(props: { readonly api: GuardianHudApi }) {
  const colors = themeColors(props.api);
  const directory = props.api.state.path.directory;
  const [model] = createResource(() => directory, async (cwd) => buildHudModel(await guardianStatus({ cwd })));
  return (
    <Show
      when={model()}
      fallback={
        <box padding={1} border borderColor={colors.border}>
          <text fg={colors.muted}>{"Loading Guardian state…"}</text>
        </box>
      }
    >
      {(resolved) => <HudView model={resolved()} colors={colors} />}
    </Show>
  );
}

export function openHud(api: GuardianHudApi): void {
  api.ui.dialog.setSize("large");
  api.ui.dialog.replace(() => <Hud api={api} />);
}
