import type { GuardianNativeToolReturn, GuardianToolInput, RecordLike } from "../src/types.ts";
import { isMutableRecord, isRecordLike } from "../src/types.ts";

export type TestToolContext = {
  sessionID?: string;
  sessionId?: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  ask: () => Promise<undefined>;
  metadata: (input: { readonly title?: string; readonly metadata?: RecordLike }) => void;
};

export type TestToolExecute = (...args: never[]) => unknown;

export type TestNativeToolReturn = GuardianNativeToolReturn & {
  readonly metadata: GuardianNativeToolReturn["metadata"] & {
    readonly preflight: RecordLike;
  };
};

function isGuardianNativeToolReturn(value: unknown): value is TestNativeToolReturn {
  return isRecordLike(value)
    && typeof value.title === "string"
    && typeof value.output === "string"
    && isMutableRecord(value.metadata);
}

export async function runTool(execute: TestToolExecute, args: GuardianToolInput, context: TestToolContext): Promise<TestNativeToolReturn> {
  const result: unknown = await Reflect.apply(execute, undefined, [args, context]);
  if (!isGuardianNativeToolReturn(result)) throw new Error("guardian tool returned an unexpected result shape");
  return result;
}

export function targetPaths(metadata: RecordLike): string[] {
  const targets = Array.isArray(metadata.targets) ? metadata.targets : [];
  return targets.map((target) => {
    const targetRecord = isRecordLike(target) ? target : {};
    return typeof targetRecord.path === "string" ? targetRecord.path : "";
  });
}

export function metadataRecord(metadata: RecordLike, key: string): RecordLike {
  return isRecordLike(metadata[key]) ? metadata[key] : {};
}

export function metadataArray(metadata: RecordLike, key: string): readonly unknown[] {
  return Array.isArray(metadata[key]) ? metadata[key] : [];
}

export function createToolContext() {
  const metadataCalls: { readonly title?: string; readonly metadata?: RecordLike }[] = [];
  return {
    context: {
      sessionID: "ses_contract",
      messageID: "msg_contract",
      agent: "build",
      directory: "/repo",
      worktree: "/repo",
      abort: new AbortController().signal,
      async ask() { return undefined; },
      metadata(input: { readonly title?: string; readonly metadata?: RecordLike }) {
        metadataCalls.push(input);
      },
    },
    metadataCalls,
  };
}
