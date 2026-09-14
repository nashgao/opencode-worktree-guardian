import assert from "node:assert/strict";
import test from "node:test";
import { maybeInjectPlanConfirmToken, rememberPlanConfirmToken } from "../src/plugin/plan-token-cache.ts";
import type { PlanCacheToolArgs } from "../src/types.ts";

test("delete-path plan-cache tokens bind the recovery archive identity", async () => {
  // Given a cached plan for one exact recovery archive.
  const planCache = new Map<string, string>();
  const planArgs = {
    mode: "plan",
    repoRoot: "/repo",
    paths: [".omo/evidence.bin"],
    archivePath: "/recovery/first.tar.gz",
    archiveSha256: "a".repeat(64),
  } as const;
  await rememberPlanConfirmToken("guardian_delete_paths", planArgs, { ok: true, status: "planned", confirmToken: "planned-token" }, planCache);

  // When apply presents a different archive identity.
  const changedApplyArgs: PlanCacheToolArgs = {
    ...planArgs,
    mode: "apply" as const,
    archivePath: "/recovery/second.tar.gz",
    archiveSha256: "b".repeat(64),
    confirmDelete: true,
  };
  await maybeInjectPlanConfirmToken("guardian_delete_paths", changedApplyArgs, planCache);

  // Then no cached authorization crosses the archive boundary, while the exact identity still reuses its token.
  assert.equal(changedApplyArgs.confirmToken, undefined);
  const matchingApplyArgs: PlanCacheToolArgs = { ...planArgs, mode: "apply", confirmDelete: true };
  await maybeInjectPlanConfirmToken("guardian_delete_paths", matchingApplyArgs, planCache);
  assert.equal(matchingApplyArgs.confirmToken, "planned-token");
});
