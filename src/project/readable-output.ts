import { isRecordLike } from "../types.ts";

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function inertText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r?\n|\r/g, "\\n")
    .replace(/confirmToken/g, "confirm-token")
    .replace(/confirmDelete/g, "confirm-delete")
    .replace(/mode=apply/g, "mode apply")
    .replace(/guardian_delete/g, "guardian delete")
    .replace(/\brm\s+-rf\b/g, "rm rf")
    .replace(/\bgit\s+clean\b/g, "git-clean");
}

function projectLines(projects: readonly unknown[]): readonly string[] {
  return projects.slice(0, 8).map((project) => {
    const record = isRecordLike(project) ? project : {};
    const name = inertText(stringField(record, "name") || stringField(record, "root") || "project");
    const roadmaps = Array.isArray(record.roadmaps) ? record.roadmaps.length : 0;
    const plans = Array.isArray(record.omoPlans) ? record.omoPlans.length : 0;
    const loops = Array.isArray(record.omoLoops) ? record.omoLoops.length : 0;
    const firstRoadmap = Array.isArray(record.roadmaps) && isRecordLike(record.roadmaps[0]) ? inertText(stringField(record.roadmaps[0], "title")) : "";
    const suffix = firstRoadmap.length > 0 ? `; ${firstRoadmap}` : "";
    return `- ${name}: ${roadmaps} roadmap(s), ${plans} plan(s), ${loops} ULW loop(s)${suffix}`;
  });
}

function warningLines(warnings: readonly unknown[]): readonly string[] {
  return warnings.slice(0, 5).map((item) => {
    const record = isRecordLike(item) ? item : {};
    const code = inertText(stringField(record, "code") || "warning");
    const message = inertText(stringField(record, "message"));
    const path = inertText(stringField(record, "path"));
    const suffix = path.length > 0 ? ` (${path})` : "";
    return `- ${code}: ${message}${suffix}`;
  });
}

export function formatProjectStatusOutput(result: unknown): string {
  const record = isRecordLike(result) ? result : {};
  const summary = isRecordLike(record.summary) ? record.summary : {};
  const projects = Array.isArray(record.projects) ? record.projects : [];
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  const warningCount = numberField(summary, "warningCount");
  const level = record.ok === true && warningCount === 0 ? "GOOD" : "WARN";
  const lines = [
    `[${level}] guardian_project_status snapshot`,
    "Guardian Project Intelligence",
    `Status: ${record.ok === true ? "ok" : "attention"}`,
    `Projects: ${numberField(summary, "projectCount")}`,
    `Roadmaps: ${numberField(summary, "roadmapCount")}`,
    `Milestone reviews: ${numberField(summary, "milestoneReviewCount")}`,
    `Plans: ${numberField(summary, "omoPlanCount")}`,
    `ULW loops: ${numberField(summary, "omoLoopCount")}`,
    `Warnings: ${warningCount}`,
    ...projectLines(projects),
  ];
  if (warnings.length > 0) lines.push("Top warnings:", ...warningLines(warnings));
  if (typeof record.reportPath === "string") lines.push(`Report: ${record.reportPath}`);
  return `${lines.join("\n")}\n`;
}
