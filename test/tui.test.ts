import assert from "node:assert/strict";
import test from "node:test";
import plugin, { id, tui, type GuardianTuiApi } from "../src/tui.ts";

const expectedSlashNames = [
  "guardian-delete-paths",
  "guardian-delete-worktree",
  "guardian-done",
  "guardian-finish",
  "guardian-finish-workflow",
  "guardian-gc",
  "guardian-goal",
  "guardian-hud",
  "guardian-hygiene",
  "guardian-init",
  "guardian-preserve",
  "guardian-project-status",
  "guardian-quarantine",
  "guardian-recover",
  "guardian-report",
  "guardian-start",
  "guardian-status",
  "guardian-unblock-finish",
];

type RegisteredCommand = {
  namespace: string;
  name: string;
  title: string;
  desc: string;
  category: string;
  slashName: string;
  run: () => void | Promise<void>;
};

type RegisteredLayer = {
  commands: readonly RegisteredCommand[];
  bindings: readonly unknown[];
};

interface HostTuiApi {
  readonly state: { readonly path: { readonly directory: string } };
  readonly keymap: { readonly registerLayer: (input: RegisteredLayer) => unknown };
  readonly route: { readonly current: { readonly name: string; readonly params?: Record<string, unknown> } };
  readonly client: { readonly session: { readonly promptAsync: (input: unknown) => Promise<void> } };
  readonly ui: { readonly toast: (input: unknown) => void; readonly dialog: { readonly setSize: (input: unknown) => void; readonly replace: (input: unknown) => void } };
  readonly theme: { readonly current: { readonly text: string; readonly textMuted: string; readonly success: string; readonly warning: string; readonly error: string; readonly accent: string; readonly border: string } };
}

function createApi(routeName = "session") {
  const prompts: unknown[] = [];
  const toasts: unknown[] = [];
  const dialogSetSizes: unknown[] = [];
  const dialogReplacements: unknown[] = [];
  let layer: RegisteredLayer | undefined;
  const api: HostTuiApi = {
    keymap: {
      registerLayer(input: RegisteredLayer) {
        layer = input;
        return () => {};
      },
    },
    route: {
      current: routeName === "session" ? { name: "session", params: { sessionID: "ses_tui" } } : { name: "home" },
    },
    state: {
      path: { directory: "/repo" },
    },
    client: {
      session: {
        async promptAsync(input: unknown) {
          prompts.push(input);
        },
      },
    },
    ui: {
      toast(input: unknown) {
        toasts.push(input);
      },
      dialog: {
        setSize(input: unknown) {
          dialogSetSizes.push(input);
        },
        replace(input: unknown) {
          dialogReplacements.push(input);
        },
      },
    },
    theme: {
      current: {
        text: "text",
        textMuted: "muted",
        success: "success",
        warning: "warning",
        error: "error",
        accent: "accent",
        border: "border",
      },
    },
  };
  return { api, prompts, toasts, dialogSetSizes, dialogReplacements, get layer() { return layer; } };
}

test("tui plugin exports OpenCode TUI module shape", () => {
  assert.equal(id, "opencode-worktree-guardian");
  assert.equal(plugin.id, "opencode-worktree-guardian");
  assert.equal(plugin.tui, tui);
});

test("tui accepts an interface-typed host API with unused extensions", async () => {
  const runtime = createApi();
  const compatibleApi: GuardianTuiApi = runtime.api;

  await tui(runtime.api);

  assert.equal(compatibleApi.state.path.directory, "/repo");
});

test("tui plugin registers Guardian slash commands", async () => {
  const runtime = createApi();

  await tui(runtime.api);

  assert.deepEqual(runtime.layer?.commands.map((command) => command.slashName).sort(), expectedSlashNames);
  assert.deepEqual(runtime.layer?.commands.map((command) => command.name).sort(), expectedSlashNames);
  assert.equal(runtime.layer?.commands.every((command) => command.namespace === "palette"), true);
  assert.equal(runtime.layer?.commands.every((command) => command.category === "Guardian"), true);
});

test("Given a registered guardian-hud command, when invoked, then it warns without a prompt or dialog", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-hud");
  assert.ok(command);

  await command.run();

  assert.deepEqual(runtime.toasts, [{
    variant: "warning",
    title: "Guardian HUD unavailable",
    message: "The visual Guardian HUD is temporarily unavailable. Use /guardian-status instead.",
  }]);
  assert.equal(runtime.prompts.length, 0);
  assert.equal(runtime.dialogSetSizes.length, 0);
  assert.equal(runtime.dialogReplacements.length, 0);
});

test("tui status prompt preserves bounded read-only scope", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-status");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { readonly parts: Array<{ readonly text: string }> };
  assert.match(prompt.parts[0].text, /guardian_status.*bounded operational scope.*names-only unscanned secondary remotes.*plan-only handoffs/s);
});

test("tui project status prompt uses the read-only native tool", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-project-status");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  assert.deepEqual(runtime.prompts[0], {
    sessionID: "ses_tui",
    directory: "/repo",
    parts: [{ type: "text", text: "Use the guardian_project_status native tool to inspect project roadmap, milestone, plan, and ULW evidence. Treat the result as read-only evidence unless writeReport=true is explicitly requested." }],
  });
});


test("tui done prompt preserves phased completion and terminal recovery gates", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-done");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /guardian_done/);
  assert.match(prompt.parts[0].text, /mode=plan/);
  assert.match(prompt.parts[0].text, /selectedTarget/);
  assert.match(prompt.parts[0].text, /from any cwd/);
  assert.match(prompt.parts[0].text, /exactly one dirty implementation target/);
  assert.match(prompt.parts[0].text, /needs-selection/);
  assert.match(prompt.parts[0].text, /primary=true/);
  assert.match(prompt.parts[0].text, /sessionId=\.\.\./);
  assert.match(prompt.parts[0].text, /branch=\.\.\./);
  assert.match(prompt.parts[0].text, /continue to mode=apply confirm=true/);
  assert.match(prompt.parts[0].text, /commitMessage/);
  assert.doesNotMatch(prompt.parts[0].text, /confirmToken/);
  assert.match(prompt.parts[0].text, /confirm=true/);
  assert.match(prompt.parts[0].text, /cleanupSweep/);
  assert.match(prompt.parts[0].text, /remaining blockers/);
  assert.match(prompt.parts[0].text, /pending-to-active proof.*empty-lease reconciliation.*state-only retirement.*fresh plan/s);
  assert.match(prompt.parts[0].text, /Never force-push/);
});

test("tui goal prompt distinguishes authorized cleanup from strict completion", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-goal");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /complete.*hygienePostcondition/s);
  assert.match(prompt.parts[0].text, /planned-partial.*complete=null/s);
  assert.match(prompt.parts[0].text, /do not treat ok as desired-state completion/);
  assert.match(prompt.parts[0].text, /no-unprotected-findings blocks residual findings/);
  assert.match(prompt.parts[0].text, /no-unprotected-residue.*unresolved reviewableCandidates.*incomplete inventory coverage/s);
  assert.match(prompt.parts[0].text, /Strict modes do not broaden deletion/);
  assert.match(prompt.parts[0].text, /only token-bound known-cleanable findings/);
  assert.match(prompt.parts[0].text, /nested-git and suspicious findings require direct explicit review/);
  assert.match(prompt.parts[0].text, /dirty nested Git requires allowDirtyNestedGit/);
  assert.match(prompt.parts[0].text, /protectedPaths are intentional retention/);
  assert.match(prompt.parts[0].text, /Resolve reviewables.*protecting intentional paths.*protected path.*guardian_delete_paths/s);
});

test("tui hygiene prompt preserves the reviewable exact-path boundary", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-hygiene");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /reviewableCandidates are inventory, not hygiene targets/);
  assert.match(prompt.parts[0].text, /guardian_delete_paths mode=plan paths=\[\.\.\.\]/);
  assert.match(prompt.parts[0].text, /directories also require allowRecursive=true/);
  assert.match(prompt.parts[0].text, /Review target status and blockers before explicit confirmation/);
  assert.match(prompt.parts[0].text, /do not pass reviewables back to guardian_hygiene/);
  assert.match(prompt.parts[0].text, /Never run raw cleanup commands/);
});

test("tui delete-worktree prompt includes explicit abandon guidance", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-delete-worktree");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /guardian_delete_worktree/);
  assert.match(prompt.parts[0].text, /Stale local Guardian branch cleanup/);
  assert.match(prompt.parts[0].text, /exact branch or terminal sessionId/);
  assert.match(prompt.parts[0].text, /terminal state or safety refs/);
  assert.match(prompt.parts[0].text, /deleteBranch=true plus abandonUnmerged=true/);
  assert.match(prompt.parts[0].text, /unmerged commit evidence/);
  assert.match(prompt.parts[0].text, /Never run raw worktree removal/);
});

test("tui delete-paths prompt points to exact confirmed deletion flow", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-delete-paths");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /guardian_delete_paths/);
  assert.match(prompt.parts[0].text, /mode=plan/);
  assert.match(prompt.parts[0].text, /explicit user confirmation/);
  assert.match(prompt.parts[0].text, /confirmDelete=true/);
  assert.match(prompt.parts[0].text, /allowTracked=true/);
  assert.match(prompt.parts[0].text, /allowRecursive=true/);
  assert.match(prompt.parts[0].text, /guardian_delete_worktree/);
});

test("tui finish prompt mentions file-specific runtime allowlists", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-finish");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /guardian_finish/);
  assert.match(prompt.parts[0].text, /file-specific runtime paths/);
  assert.match(prompt.parts[0].text, /allowDirtyPaths/);
});

test("tui finish-workflow prompt preserves Guardian gated cleanup boundaries", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-finish-workflow");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /guardian_finish_workflow/);
  assert.match(prompt.parts[0].text, /mode=plan/);
  assert.match(prompt.parts[0].text, /explicit user confirmation/);
  assert.match(prompt.parts[0].text, /mode=apply confirm=true/);
  assert.match(prompt.parts[0].text, /redundant merged Guardian worktrees/);
  assert.match(prompt.parts[0].text, /bounded operational scope.*names-only unscanned secondary remotes/s);
  assert.match(prompt.parts[0].text, /must not invent commits/);
  assert.match(prompt.parts[0].text, /raw cleanup commands/);
});

test("tui slash command warns outside a session", async () => {
  const runtime = createApi("home");
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-status");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 0);
  assert.deepEqual(runtime.toasts, [{ variant: "warning", title: "Guardian", message: "Open a session before running Guardian commands." }]);
});
