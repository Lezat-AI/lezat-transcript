// Types and helpers shared by the meeting-tasks page and its approval modal.
import { isoToDayMonthYear } from "@/utils/dayMonthYear";

import type { BoardMatch } from "@/bindings";

export interface CloudActionItem {
  id: string;
  meeting_id: string | null;
  meeting_title: string | null;
  description: string | null;
  assignee: string | null;
  assignee_notion_user_id?: string | null;
  // Newer backends send the task title and meeting name separately (older ones
  // put the task title in meeting_title).
  title?: string | null;
  meeting_name?: string | null;
  /** Project the task belongs to (PeopleZat, MediaZat…), when the backend knows it. */
  project?: string | null;
  due_date: string | null;
  /** "pending" | "completed_previous" (work that was already done before the meeting). */
  task_type: string;
  status: string;
  synced_to: string[];
  created_at: string | null;
  /** Card still open on the user's board that this task repeats. */
  board_match?: BoardMatch | null;
  /** Kind of work (one of `WORK_TYPES`), null when not classified. */
  work_type?: string | null;
  /** `due_date` is the team default (next Monday): nobody said a date. */
  due_date_defaulted?: boolean;
}

export interface IntegrationInfo {
  provider: string;
  connected: boolean;
  config: {
    database_id: string | null;
    board_id: string | null;
    todo_status: string | null;
  } | null;
}

export interface SelectOption {
  id: string;
  name: string;
}

export interface NotionPersonOption {
  id: string;
  name: string;
  email?: string | null;
}

/** Edits sent when approving; owner fields travel together when picked from Notion. */
export interface ItemEdits {
  /** Task title (the Notion card's name); never sent empty. */
  title?: string;
  description?: string;
  assignee?: string;
  assignee_notion_user_id?: string;
  assignee_email?: string;
  due_date?: string;
  notion_database_id?: string;
  /** "pending" | "completed_previous". */
  task_type?: string;
  /** Notion status (column) for the card; absent = automatic by task type. */
  notion_status?: string;
  /** Update this open card (the task's `board_match`) instead of creating one. */
  notion_existing_page_id?: string;
  /** One of `WORK_TYPES`; "" clears it. */
  work_type?: string;
}

export interface PreloadedConfig {
  notionDbs: SelectOption[];
  mondayBoards: SelectOption[];
  notionStatuses: Record<string, SelectOption[]>; // keyed by database_id
  mondayStatuses: Record<string, SelectOption[]>; // keyed by board_id
  notionPeople: NotionPersonOption[];
}

/** Kinds of work a task can be (labels: `actionItems.workType.<key>`). */
export const WORK_TYPES = [
  "construir",
  "qa",
  "vender",
  "entregar",
  "marketing",
  "interno",
] as const;

export const TASK_TYPE_PENDING = "pending";
export const TASK_TYPE_PREVIOUS = "completed_previous";

/** Calendars need a date: tasks without one go to the other targets only. */
export const CALENDAR_TARGETS = ["google-calendar", "outlook-calendar"];

/** "2026-10-01" (or an ISO datetime) → "01/10/2026". Other values pass through. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  return isoToDayMonthYear(value) || value;
}

const normalizePersonName = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The Notion person a free-text owner refers to: exact name, else a unique partial match. */
export function findNotionPerson(
  name: string,
  people: NotionPersonOption[],
): NotionPersonOption | undefined {
  const wanted = normalizePersonName(name);
  if (!wanted) return undefined;
  const exact = people.filter((p) => normalizePersonName(p.name) === wanted);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const tokens = wanted.split(" ");
  const partial = people.filter((p) => {
    const personTokens = normalizePersonName(p.name).split(" ");
    return tokens.every((t) => personTokens.includes(t));
  });
  return partial.length === 1 ? partial[0] : undefined;
}
