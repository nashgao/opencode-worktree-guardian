import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { expectedCodexAdapterFiles, expectedCodexSkillNames, expectedCommandAssets, expectedPackagedCommandTools, expectedSlashNames, expectedToolNames, findLegacyHygieneReferences, projectRoot } from "./package-smoke-helpers.ts";

test("public docs and package inventory stay aligned with guardian command surface", async () => {
  const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8");

  for (const commandAsset of expectedCommandAssets) {
    await fs.access(path.join(projectRoot, commandAsset));
  }

  for (const codexAdapterFile of expectedCodexAdapterFiles) {
    await fs.access(path.join(projectRoot, codexAdapterFile));
  }

  for (const codexSkillName of expectedCodexSkillNames) {
    const skill = await fs.readFile(path.join(projectRoot, "codex", "skills", codexSkillName, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\nname: ${codexSkillName}\\n`), `${codexSkillName} must have Codex skill frontmatter`);
  }

  for (const [commandName, toolName] of expectedPackagedCommandTools) {
    const command = await fs.readFile(path.join(projectRoot, "commands", `${commandName}.md`), "utf8");
    assert.equal(command.includes(`\`${toolName}\``), true, `${commandName} must route to ${toolName}`);
    assert.equal(readme.includes(`/opencode-worktree-guardian:${commandName}`), true, `README must document packaged command ${commandName}`);
  }

  for (const toolName of expectedToolNames) {
    assert.equal(readme.includes(`\`${toolName}\``), true, `README must document native tool ${toolName}`);
  }

  for (const slashName of expectedSlashNames) {
    assert.equal(readme.includes(`/${slashName}`), true, `README must document slash command /${slashName}`);
  }

  const doneCommand = await fs.readFile(path.join(projectRoot, "commands", "done.md"), "utf8");
  const doneSkill = await fs.readFile(path.join(projectRoot, "codex", "skills", "guardian-done", "SKILL.md"), "utf8");
  for (const surface of [readme, doneCommand, doneSkill]) {
    assert.match(surface, /one dirty implementation target|exactly one dirty implementation target/);
    assert.match(surface, /needs-selection/);
    assert.match(surface, /primary=true/);
    assert.match(surface, /sessionId=\.\.\./);
    assert.match(surface, /branch=\.\.\./);
  }

  assert.deepEqual(await findLegacyHygieneReferences(), []);
});
