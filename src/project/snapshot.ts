import fs from "node:fs/promises";
import path from "node:path";
import { getCurrentBranch, getDirtyFiles, getHeadCommit, getRepoRoot, listWorktrees, tryGit } from "../git.ts";
import { getGuardianPaths, readState } from "../state.ts";
import { errorCode, errorMessage } from "../types.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { parseMilestoneReview, parseOmoPlan, parseRoadmap } from "./markdown.ts";
import { parseOmoLoop } from "./omo.ts";
import type { CollectProjectSnapshotInput, ProjectGitSummary, ProjectIntelligenceProject, ProjectMilestoneReview, ProjectOmoLoop, ProjectOmoPlan, ProjectRoadmap, ProjectSnapshot, ProjectWarning } from "./types.ts";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "./types.ts";
import { PROJECT_LIMITS, readArtifactDirectory, readSmallTextFile, relativeArtifactPath, warning } from "./parser-utils.ts";

type ScanContext = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly warnings: ProjectWarning[];
};

async function resolveRepoRoot(input: CollectProjectSnapshotInput): Promise<string> {
  if (typeof input.repoRoot === "string" && input.repoRoot.length > 0) return path.resolve(input.repoRoot);
  return getRepoRoot(typeof input.cwd === "string" ? input.cwd : process.cwd());
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function normalizeProjectRoots(context: ScanContext, roots: readonly unknown[] | undefined): Promise<readonly string[]> {
  const rawRoots = roots && roots.length > 0 ? roots : [context.repoRoot];
  const limitedRoots = rawRoots.slice(0, PROJECT_LIMITS.maxRoots);
  if (rawRoots.length > PROJECT_LIMITS.maxRoots) {
    context.warnings.push(warning("root_limit", `Only the first ${PROJECT_LIMITS.maxRoots} project roots were scanned`));
  }

  const resolvedRoots: string[] = [];
  const seen = new Set<string>();
  const relativeBase = context.cwd.length > 0 ? context.cwd : context.repoRoot;
  for (const rawRoot of limitedRoots) {
    if (typeof rawRoot !== "string") {
      context.warnings.push(warning("root_invalid_type", "Project root is not a string and was skipped"));
      continue;
    }
    if (rawRoot.trim().length === 0) {
      context.warnings.push(warning("root_empty", "Project root is empty and was skipped"));
      continue;
    }
    const candidate = path.resolve(path.isAbsolute(rawRoot) ? rawRoot : path.join(relativeBase, rawRoot));
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        context.warnings.push(warning("root_symlink", "Project root is a symlink and was skipped", candidate));
        continue;
      }
      if (!stat.isDirectory()) {
        context.warnings.push(warning("root_not_directory", "Project root is not a directory and was skipped", candidate));
        continue;
      }
      const real = await fs.realpath(candidate);
      if (seen.has(real)) {
        context.warnings.push(warning("root_duplicate", "Project root duplicates an earlier realpath and was skipped", candidate));
        continue;
      }
      seen.add(real);
      resolvedRoots.push(real);
    } catch (error) {
      const message = errorCode(error) === "ENOENT" ? "Project root does not exist and was skipped" : `Project root could not be read: ${errorMessage(error)}`;
      context.warnings.push(warning("root_unreadable", message, candidate));
    }
  }
  return resolvedRoots.sort((left, right) => left.localeCompare(right));
}

async function projectGitSummary(root: string): Promise<ProjectGitSummary> {
  const inside = await tryGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return { available: false, error: inside.ok ? "not a git worktree" : inside.error.message };
  }
  try {
    return {
      available: true,
      branch: await getCurrentBranch(root),
      head: await getHeadCommit(root),
      dirtyFileCount: (await getDirtyFiles(root)).length,
    };
  } catch (error) {
    return { available: false, error: errorMessage(error) };
  }
}

async function collectRoadmaps(root: string, warnings: ProjectWarning[]): Promise<readonly ProjectRoadmap[]> {
  const roadmapPath = path.join(root, "definition", "roadmap.md");
  const raw = await readSmallTextFile(root, roadmapPath, warnings);
  return raw === null ? [] : [parseRoadmap(raw, relativeArtifactPath(root, roadmapPath))].slice(0, PROJECT_LIMITS.maxRoadmaps);
}

async function collectMilestoneReviews(root: string, warnings: ProjectWarning[]): Promise<readonly ProjectMilestoneReview[]> {
  const reviewsDir = path.join(root, ".milestones", "reviews");
  const entries = await readArtifactDirectory(root, reviewsDir, warnings);
  const reviews: ProjectMilestoneReview[] = [];
  const names = entries.map((item) => item.name).filter((name) => /impl-rating.*\.(md|txt)$/i.test(name)).sort().slice(0, PROJECT_LIMITS.maxMilestoneReviews);
  for (const entry of names) {
    const dirent = entries.find((item) => item.name === entry);
    const artifactPath = path.join(reviewsDir, entry);
    if (dirent?.isSymbolicLink()) warnings.push(warning("artifact_symlink", "Artifact path is a symlink and was skipped", relativeArtifactPath(root, artifactPath)));
    if (!dirent?.isFile()) continue;
    const raw = await readSmallTextFile(root, artifactPath, warnings);
    if (raw !== null) reviews.push(parseMilestoneReview(raw, relativeArtifactPath(root, artifactPath)));
  }
  return reviews;
}

async function collectOmoPlans(root: string, warnings: ProjectWarning[]): Promise<readonly ProjectOmoPlan[]> {
  const plansDir = path.join(root, ".omo", "plans");
  const entries = await readArtifactDirectory(root, plansDir, warnings);
  const plans: ProjectOmoPlan[] = [];
  for (const entry of entries.map((item) => item.name).filter((name) => name.endsWith(".md")).sort().slice(0, PROJECT_LIMITS.maxOmoPlans)) {
    const dirent = entries.find((item) => item.name === entry);
    const artifactPath = path.join(plansDir, entry);
    if (dirent?.isSymbolicLink()) warnings.push(warning("artifact_symlink", "Artifact path is a symlink and was skipped", relativeArtifactPath(root, artifactPath)));
    if (!dirent?.isFile()) continue;
    const raw = await readSmallTextFile(root, artifactPath, warnings);
    if (raw !== null) plans.push(parseOmoPlan(raw, relativeArtifactPath(root, artifactPath)));
  }
  return plans;
}

async function collectOmoLoops(root: string, warnings: ProjectWarning[]): Promise<readonly ProjectOmoLoop[]> {
  const loopsDir = path.join(root, ".omo", "ulw-loop");
  const entries = await readArtifactDirectory(root, loopsDir, warnings);
  const loops: ProjectOmoLoop[] = [];
  for (const entry of entries.map((item) => item.name).sort().slice(0, PROJECT_LIMITS.maxOmoLoops)) {
    const dirent = entries.find((item) => item.name === entry);
    const loopPath = path.join(loopsDir, entry);
    if (dirent?.isSymbolicLink()) warnings.push(warning("artifact_symlink", "Artifact directory is a symlink and was skipped", relativeArtifactPath(root, loopPath)));
    if (!dirent?.isDirectory()) continue;
    loops.push(await parseOmoLoop(root, loopPath, warnings));
  }
  return loops;
}

async function collectProject(root: string, context: ScanContext): Promise<ProjectIntelligenceProject> {
  const warnings: ProjectWarning[] = [];
  const git = await projectGitSummary(root);
  if (!git.available) warnings.push(warning("root_not_git", `Project root is not a git worktree: ${git.error ?? "unavailable"}`, "."));
  const roadmaps = await collectRoadmaps(root, warnings);
  const milestoneReviews = await collectMilestoneReviews(root, warnings);
  const omoPlans = await collectOmoPlans(root, warnings);
  const omoLoops = await collectOmoLoops(root, warnings);
  context.warnings.push(...warnings);
  const relativeRoot = isInside(context.repoRoot, root) ? path.relative(context.repoRoot, root) || "." : root;
  return {
    root,
    name: path.basename(root),
    relativeRoot,
    git,
    roadmaps,
    milestoneReviews,
    omoPlans,
    omoLoops,
    warnings,
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<readonly R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function guardianSummary(repoRoot: string, warnings: ProjectWarning[]): Promise<Omit<ProjectSnapshot["guardian"], "warningCount">> {
  try {
    const paths = await getGuardianPaths(repoRoot);
    const state = await readState(paths, { repoRoot, config: DEFAULT_CONFIG });
    let worktrees = [];
    try {
      worktrees = await listWorktrees(repoRoot);
    } catch (error) {
      warnings.push(warning("guardian_git_unavailable", `Guardian worktree summary could not be read: ${errorMessage(error)}`, repoRoot));
    }
    let dirtyFiles = [];
    try {
      dirtyFiles = await getDirtyFiles(repoRoot);
    } catch (error) {
      warnings.push(warning("guardian_git_unavailable", `Guardian dirty-file summary could not be read: ${errorMessage(error)}`, repoRoot));
    }
    const activeSessionCount = Object.values(state.sessions).filter((session) => session.status === "active").length;
    const safetyRefCount = Object.values(state.sessions).reduce((total, session) => total + (Array.isArray(session.safety_refs) ? session.safety_refs.length : 0), 0);
    return {
      repoRoot,
      stateVersion: state.state_version ?? 0,
      activeSessionCount,
      worktreeCount: worktrees.length,
      dirtyFileCount: dirtyFiles.length,
      safetyRefCount,
    };
  } catch (error) {
    warnings.push(warning("guardian_unavailable", `Guardian summary could not be read: ${errorMessage(error)}`, repoRoot));
    return {
      repoRoot,
      stateVersion: 0,
      activeSessionCount: 0,
      worktreeCount: 0,
      dirtyFileCount: 0,
      safetyRefCount: 0,
    };
  }
}

export async function collectProjectSnapshot(input: CollectProjectSnapshotInput = {}): Promise<ProjectSnapshot> {
  const repoRoot = await resolveRepoRoot(input);
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? path.resolve(input.cwd) : repoRoot;
  const warnings: ProjectWarning[] = [];
  const context = { repoRoot, cwd, warnings };
  const projectRoots = await normalizeProjectRoots(context, input.projectRoots);
  const projects = await mapLimit(projectRoots, PROJECT_LIMITS.maxConcurrentFileReads, (root) => collectProject(root, context));
  const guardian = await guardianSummary(repoRoot, warnings);
  const summary = {
    projectCount: projects.length,
    roadmapCount: projects.reduce((total, project) => total + project.roadmaps.length, 0),
    milestoneReviewCount: projects.reduce((total, project) => total + project.milestoneReviews.length, 0),
    omoPlanCount: projects.reduce((total, project) => total + project.omoPlans.length, 0),
    omoLoopCount: projects.reduce((total, project) => total + project.omoLoops.length, 0),
    warningCount: warnings.length,
  };

  return {
    ok: projects.length > 0,
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    repoRoot,
    projectRoots,
    guardian: { ...guardian, warningCount: warnings.length },
    projects,
    summary,
    warnings,
  };
}
