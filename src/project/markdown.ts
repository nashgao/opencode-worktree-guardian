import type { ProjectMilestoneReview, ProjectOmoPlan, ProjectRoadmap, ProjectRoadmapPhase } from "./types.ts";
import { countChecklist, parseHeadings, sectionBetween, tableRows } from "./parser-utils.ts";

function titleFromMarkdown(markdown: string, fallback: string): string {
  return parseHeadings(markdown).find((heading) => heading.level === 1)?.text ?? fallback;
}

function linesForHeading(markdown: string, headingLine: number, nextHeadingLine: number | undefined): readonly string[] {
  const lines = markdown.split("\n");
  return lines.slice(headingLine + 1, nextHeadingLine);
}

function firstDimensionStatusNotesTable(markdown: string): readonly string[] {
  const lines = markdown.split("\n").map((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const columns = line.split("|").map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (!columns.includes("dimension") || !columns.includes("status") || !columns.includes("notes")) continue;
    const rows: string[] = [line];
    for (const candidate of lines.slice(index + 1)) {
      if (!candidate.startsWith("|") || !candidate.endsWith("|")) break;
      if (/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(candidate)) continue;
      rows.push(candidate);
    }
    return rows;
  }
  return [];
}

export function parseRoadmap(markdown: string, artifactPath: string): ProjectRoadmap {
  const headings = parseHeadings(markdown);
  const sections = headings.filter((heading) => heading.level === 2).map((heading) => heading.text);
  const phases: ProjectRoadmapPhase[] = [];

  for (const [index, heading] of headings.entries()) {
    if (heading.level !== 3) continue;
    const section = [...headings.slice(0, index)].reverse().find((candidate) => candidate.level === 2)?.text ?? "";
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= 3);
    phases.push({
      section,
      title: heading.text,
      checklist: countChecklist(linesForHeading(markdown, heading.line, next?.line)),
    });
  }

  return {
    path: artifactPath,
    title: titleFromMarkdown(markdown, artifactPath),
    sections,
    phases,
    checklist: countChecklist(markdown.split("\n")),
    tableRows: tableRows(markdown),
  };
}

export function parseMilestoneReview(markdown: string, artifactPath: string): ProjectMilestoneReview {
  const headings = parseHeadings(markdown);
  const generated = /^Generated:\s*(.+)$/im.exec(markdown)?.[1]?.trim();
  const updated = /^Updated:\s*(.+)$/im.exec(markdown)?.[1]?.trim();
  const rawScore = /^Score:\s*(\d{1,3})\s*\/\s*100\b/im.exec(markdown)?.[1];
  const score = rawScore === undefined ? undefined : Number.parseInt(rawScore, 10);

  return {
    path: artifactPath,
    title: titleFromMarkdown(markdown, artifactPath),
    ...(generated === undefined ? {} : { generated }),
    ...(updated === undefined ? {} : { updated }),
    ...(Number.isFinite(score) ? { score } : {}),
    sections: headings.filter((heading) => heading.level >= 2).map((heading) => heading.text),
    tableRows: firstDimensionStatusNotesTable(markdown),
  };
}

export function parseOmoPlan(markdown: string, artifactPath: string): ProjectOmoPlan {
  const headings = parseHeadings(markdown);
  const todos = sectionBetween(markdown, "Todos");
  return {
    path: artifactPath,
    title: titleFromMarkdown(markdown, artifactPath),
    tlDr: sectionBetween(markdown, "TL;DR"),
    headings: headings.map((heading) => heading.text),
    todoCount: countChecklist(todos.split("\n")),
    hasFinalVerification: headings.some((heading) => /^Final verification wave$/i.test(heading.text)),
  };
}
