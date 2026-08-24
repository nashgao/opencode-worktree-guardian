import assert from "node:assert/strict";
import test from "node:test";
import { measureReviewableCandidates } from "../src/hygiene-reviewable.ts";

type Candidate = {
  readonly path: string;
  readonly status: "ignored" | "untracked";
  readonly fileCount: number;
};

const candidates: readonly Candidate[] = [
  { path: "z", status: "untracked", fileCount: 1 },
  { path: "a", status: "untracked", fileCount: 1 },
  { path: "m", status: "untracked", fileCount: 1 },
];

async function measure(input: readonly Candidate[]) {
  const calls: Array<readonly [string, number]> = [];
  const measured = await measureReviewableCandidates(input, async (candidatePath, maxEntries) => {
    calls.push([candidatePath, maxEntries]);
    return {
      bytes: candidatePath === "m" ? 1 : 0,
      truncated: candidatePath !== "a",
      visited: maxEntries,
    };
  }, { perCandidate: 3, total: 4 });
  return {
    calls,
    candidates: measured.map(({ path, bytes, bytesTruncated }) => [path, bytes, bytesTruncated]),
  };
}

test("aggregate reviewable measurement stays deterministic after its shared budget is exhausted", async () => {
  const forward = await measure(candidates);
  const reversed = await measure([...candidates].reverse());

  assert.deepEqual(forward.calls, [["a", 3], ["m", 1], ["z", 0]]);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward.candidates, [["m", 1, true], ["z", 0, true], ["a", 0, false]]);
});
