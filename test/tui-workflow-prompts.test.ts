import assert from "node:assert/strict";
import test from "node:test";
import { tui, type GuardianTuiApi } from "../src/tui.ts";

type RegisteredCommand = {
  slashName: string;
  run: () => void | Promise<void>;
};

type RegisteredLayer = {
  commands: readonly RegisteredCommand[];
};

function createApi() {
  const prompts: unknown[] = [];
  let layer: RegisteredLayer | undefined;
  const api: GuardianTuiApi = {
    keymap: {
      registerLayer(input: RegisteredLayer) {
        layer = input;
        return () => {};
      },
    },
    route: { current: { name: "session", params: { sessionID: "ses_tui" } } },
    state: { path: { directory: "/repo" } },
    client: {
      session: {
        async promptAsync(input: unknown) {
          prompts.push(input);
        },
      },
    },
    ui: {
      toast() {},
    },
  };
  return { api, prompts, get layer() { return layer; } };
}

async function promptFor(slashName: string) {
  const runtime = createApi();
  await tui(runtime.api);
  const command = runtime.layer?.commands.find((candidate) => candidate.slashName === slashName);
  assert.ok(command);
  await command.run();
  assert.equal(runtime.prompts.length, 1);
  return runtime.prompts[0] as { readonly parts: Array<{ readonly text: string }> };
}

test("tui status prompt preserves bounded read-only scope", async () => {
  const prompt = await promptFor("guardian-status");
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
  const prompt = await promptFor("guardian-done");
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
  const prompt = await promptFor("guardian-goal");
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
  const prompt = await promptFor("guardian-hygiene");
  assert.match(prompt.parts[0].text, /reviewableCandidates are inventory, not hygiene targets/);
  assert.match(prompt.parts[0].text, /guardian_delete_paths mode=plan paths=\[\.\.\.\]/);
  assert.match(prompt.parts[0].text, /directories also require allowRecursive=true/);
  assert.match(prompt.parts[0].text, /Review target status and blockers before explicit confirmation/);
  assert.match(prompt.parts[0].text, /do not pass reviewables back to guardian_hygiene/);
  assert.match(prompt.parts[0].text, /Never run raw cleanup commands/);
});
