// Which project (PeopleZat, MediaZat…) a meeting task belongs to.
//
// The backend sends `project` (null = no project); we only tidy its spelling.

/**
 * Known projects, most specific first: "Lezat" must stay last because it is
 * contained in "PeopleZat" ("peop-lezat") once spaces and case are ignored.
 */
export const KNOWN_PROJECTS = [
  "PeopleZat",
  "SocialZat",
  "MediaZat",
  "WealthZat",
  "Wazat",
  "Teucalí",
  "Kaza Living",
  "Lezat",
] as const;

/** Projects offered when moving a task, alphabetically ("Kaza Living", "Lezat"…). */
export const PROJECT_OPTIONS: readonly string[] = [...KNOWN_PROJECTS].sort(
  (a, b) => a.localeCompare(b, "es"),
);

/** Lowercase, no accents, letters and digits only: "Teucalí " → "teucali". */
function compact(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Tidy a backend project name: known projects get their usual spelling. */
function canonicalProject(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const known = KNOWN_PROJECTS.find((p) => compact(p) === compact(trimmed));
  return known ?? trimmed;
}

/** Project for a task: the backend's value (null = no project). */
export function resolveProject(item: {
  project?: string | null;
}): string | null {
  const value = item.project?.trim();
  if (!value) return null;
  return canonicalProject(value) ?? value;
}

export interface ProjectGroup<T> {
  /** null = tasks we couldn't place in a project. */
  project: string | null;
  items: T[];
}

/**
 * Split tasks into project groups: projects alphabetically, "no project" last.
 * Order of tasks inside a group is preserved.
 */
export function groupByProject<
  T extends { project?: string | null },
>(items: T[]): ProjectGroup<T>[] {
  const map = new Map<string | null, T[]>();
  for (const item of items) {
    const key = resolveProject(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return Array.from(map.entries())
    .map(([project, groupItems]) => ({ project, items: groupItems }))
    .sort((a, b) => {
      if (a.project === null) return 1;
      if (b.project === null) return -1;
      return a.project.localeCompare(b.project, "es", { sensitivity: "base" });
    });
}
