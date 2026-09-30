// Which project (PeopleZat, MediaZat…) a meeting task belongs to.
//
// The backend sends `project` when it can tell; older backends don't, so we
// fall back to spotting a known project name in the task's Notion board title
// (e.g. "MedIAZat Kanban (B2C)" → MediaZat). Anything else is "no project".

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

/** The known project named somewhere in `text`, if any. */
export function detectProject(text: string | null | undefined): string | null {
  if (!text) return null;
  const haystack = compact(text);
  if (!haystack) return null;
  return KNOWN_PROJECTS.find((p) => haystack.includes(compact(p))) ?? null;
}

/** Tidy a backend project name: known projects get their usual spelling. */
function canonicalProject(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const known = KNOWN_PROJECTS.find((p) => compact(p) === compact(trimmed));
  return known ?? trimmed;
}

/** Project for a task: the backend's value, else a guess from its Notion board, else null. */
export function resolveProject(item: {
  project?: string | null;
  notion_database_title?: string | null;
  notion_database_confidence?: string | null;
}): string | null {
  // The backend always sends `project` (null = no project, possibly the user's
  // choice): respect it. Only records from older backends lack the field.
  if (item.project !== undefined) {
    const value = item.project?.trim();
    if (!value) return null;
    return canonicalProject(value) ?? value;
  }
  // Like the backend: only a confidently suggested board says which project it is.
  const confident =
    item.notion_database_confidence === "high" ||
    item.notion_database_confidence === "medium";
  return confident ? detectProject(item.notion_database_title) : null;
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
  T extends { project?: string | null; notion_database_title?: string | null },
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
