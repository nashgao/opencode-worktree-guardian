import assert from "node:assert/strict";
import test from "node:test";
import plugin, { id, tui } from "../src/tui.ts";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

const expectedSlashNames = [
  "guardian-delete-worktree",
  "guardian-done",
  "guardian-finish",
  "guardian-finish-workflow",
  "guardian-hygiene",
  "guardian-hygiene-cleanup",
  "guardian-preserve",
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
  run: () => Promise<void>;
};

type RegisteredLayer = {
  commands: RegisteredCommand[];
  bindings: unknown[];
};

function createApi(routeName = "session") {
  const prompts: unknown[] = [];
  const toasts: unknown[] = [];
  let layer: RegisteredLayer | undefined;
  const api = {
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
    },
  };
  return { api: api as unknown as TuiPluginApi, prompts, toasts, get layer() { return layer; } };
}

test("tui plugin exports OpenCode TUI module shape", () => {
  assert.equal(id, "opencode-worktree-guardian");
  assert.equal(plugin.id, "opencode-worktree-guardian");
  assert.equal(plugin.tui, tui);
});

test("tui plugin registers Guardian slash commands", async () => {
  const runtime = createApi();

  await tui(runtime.api);

  assert.deepEqual(runtime.layer?.commands.map((command) => command.slashName).sort(), expectedSlashNames);
  assert.deepEqual(runtime.layer?.commands.map((command) => command.name).sort(), expectedSlashNames);
  assert.equal(runtime.layer?.commands.every((command) => command.namespace === "palette"), true);
  assert.equal(runtime.layer?.commands.every((command) => command.category === "Guardian"), true);
});

test("tui slash command dispatches a Guardian prompt in the current session", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-status");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  assert.deepEqual(runtime.prompts[0], {
    sessionID: "ses_tui",
    directory: "/repo",
    parts: [{ type: "text", text: "Use the guardian_status native tool to inspect the current repository. Treat the result as read-only evidence." }],
  });
});


test("tui done prompt preserves primary-main token gates and separate cleanup", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-done");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /guardian_done/);
  assert.match(prompt.parts[0].text, /mode=plan/);
  assert.match(prompt.parts[0].text, /commitMessage/);
  assert.doesNotMatch(prompt.parts[0].text, /confirmToken/);
  assert.match(prompt.parts[0].text, /confirm=true/);
  assert.match(prompt.parts[0].text, /cleanupPlan/);
  assert.match(prompt.parts[0].text, /do not silently apply cleanup/);
  assert.match(prompt.parts[0].text, /Never force-push/);
});

test("tui hygiene-cleanup prompt preserves report-only hygiene and confirmDelete flow", async () => {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === "guardian-hygiene-cleanup");
  assert.ok(command);

  await command.run();

  assert.equal(runtime.prompts.length, 1);
  const prompt = runtime.prompts[0] as { parts: Array<{ text: string }> };
  assert.match(prompt.parts[0].text, /guardian_hygiene_cleanup/);
  assert.match(prompt.parts[0].text, /mode=plan/);
  assert.match(prompt.parts[0].text, /explicit user confirmation/);
  assert.match(prompt.parts[0].text, /confirmDelete=true/);
  assert.doesNotMatch(prompt.parts[0].text, /confirmToken/);
  assert.match(prompt.parts[0].text, /guardian_hygiene remains report-only/);
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
  assert.match(prompt.parts[0].text, /redundant merged Guardian worktrees/);
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
