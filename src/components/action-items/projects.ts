// Which project a meeting task belongs to.
//
// The backend sends `project` (null = no project); we only tidy its spelling.
// The list of an organization's projects now comes from the backend
// (`GET /api/org/projects`), per-organization, rather than a hardcoded list.
// It is cached in-module so the pure helpers below can tidy spelling without
// re-fetching; it starts empty, so an org with no projects shows every task as
// "no project".

/**
 * The org's known projects, kept in a module-level cache that the org store
 * fills from the backend. Empty until loaded (NOT a hardcoded Lezat list).
 */
let knownProjects: readonly string[] = [];

/** Replace the cached org project list (called by the org store after a fetch). */
export function setKnownProjects(projects: readonly string[]): void {
  knownProjects = [...projects];
}

/** The cached org project list. */
export function getKnownProjects(): readonly string[] {
  return knownProjects;
}

/** Projects offered when moving a task, alphabetically ("Kaza Living", "Lezat"…). */
export function projectOptions(): string[] {
  return [...knownProjects].sort((a, b) => a.localeCompare(b, "es"));
}

/**
 * Renamed products: tasks saved with the old name show the new one. Kept only as
 * a local display tidy; the source of truth for projects is the backend.
 */
const RENAMED_PROJECTS: Record<string, string> = {
  wazat: "BotZat",
  mediazatb2c: "NewsZat",
  mediazatb2b: "MediaZat",
};

/** Lowercase, no accents, letters and digits only: "Teucalí " → "teucali". */
function compact(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Tidy a backend project name: known projects get their usual spelling. */
export function canonicalProject(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = compact(trimmed);
  const known = knownProjects.find((p) => compact(p) === key);
  return known ?? RENAMED_PROJECTS[key] ?? trimmed;
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
