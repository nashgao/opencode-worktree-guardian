import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const skillNames = ["guardian-done", "guardian-finish-workflow", "guardian-hygiene", "worktree-guardian"] as const;

test("completion skills require relaying the post-completion hygiene inventory", async () => {
  // Given
  const root = path.resolve("codex", "skills");

  // When
  const skills = await Promise.all(skillNames.map(async (name) => fs.readFile(path.join(root, name, "SKILL.md"), "utf8")));

  // Then
  for (const skill of skills) {
    assert.match(skill, /postCompletionHygiene|filesystem-only empty directories/);
  }
});
