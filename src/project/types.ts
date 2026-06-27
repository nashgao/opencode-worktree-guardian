export const PROJECT_SNAPSHOT_SCHEMA_VERSION = "project-snapshot/v1";

export type ProjectWarning = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

export type ProjectTodoCount = {
  readonly total: number;
  readonly done: number;
  readonly pending: number;
};

export type ProjectRoadmapPhase = {
  readonly section: string;
  readonly title: string;
  readonly checklist: ProjectTodoCount;
};

export type ProjectRoadmap = {
  readonly path: string;
  readonly title: string;
  readonly sections: readonly string[];
  readonly phases: readonly ProjectRoadmapPhase[];
  readonly checklist: ProjectTodoCount;
  readonly tableRows: readonly string[];
};

export type ProjectMilestoneReview = {
  readonly path: string;
  readonly title: string;
  readonly generated?: string;
  readonly updated?: string;
  readonly score?: number;
  readonly sections: readonly string[];
  readonly tableRows: readonly string[];
};

export type ProjectOmoPlan = {
  readonly path: string;
  readonly title: string;
  readonly tlDr: string;
  readonly headings: readonly string[];
  readonly todoCount: ProjectTodoCount;
  readonly hasFinalVerification: boolean;
};

export type ProjectOmoGoal = {
  readonly id?: string;
  readonly title?: string;
  readonly objective?: string;
  readonly status?: string;
};

export type ProjectLedgerEvent = {
  readonly kind?: string;
  readonly at?: string;
  readonly message?: string;
  readonly goalId?: string;
};

export type ProjectOmoLoop = {
  readonly path: string;
  readonly loopId: string;
  readonly goals: readonly ProjectOmoGoal[];
  readonly goalStatusCounts: Readonly<Record<string, number>>;
  readonly ledgerEvents: readonly ProjectLedgerEvent[];
  readonly malformedLedgerLineCount: number;
};

export type ProjectGitSummary = {
  readonly available: boolean;
  readonly branch?: string | null;
  readonly head?: string;
  readonly dirtyFileCount?: number;
  readonly error?: string;
};

export type ProjectIntelligenceProject = {
  readonly root: string;
  readonly name: string;
  readonly relativeRoot: string;
  readonly git: ProjectGitSummary;
  readonly roadmaps: readonly ProjectRoadmap[];
  readonly milestoneReviews: readonly ProjectMilestoneReview[];
  readonly omoPlans: readonly ProjectOmoPlan[];
  readonly omoLoops: readonly ProjectOmoLoop[];
  readonly warnings: readonly ProjectWarning[];
};

export type ProjectSnapshot = {
  readonly ok: boolean;
  readonly schemaVersion: typeof PROJECT_SNAPSHOT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly repoRoot: string;
  readonly projectRoots: readonly string[];
  readonly guardian: {
    readonly repoRoot: string;
    readonly stateVersion: number;
    readonly activeSessionCount: number;
    readonly worktreeCount: number;
    readonly dirtyFileCount: number;
    readonly safetyRefCount: number;
    readonly warningCount: number;
  };
  readonly projects: readonly ProjectIntelligenceProject[];
  readonly summary: {
    readonly projectCount: number;
    readonly roadmapCount: number;
    readonly milestoneReviewCount: number;
    readonly omoPlanCount: number;
    readonly omoLoopCount: number;
    readonly warningCount: number;
  };
  readonly warnings: readonly ProjectWarning[];
};

export type CollectProjectSnapshotInput = {
  readonly repoRoot?: string;
  readonly cwd?: string;
  readonly projectRoots?: readonly unknown[];
  readonly generatedAt?: string;
};
