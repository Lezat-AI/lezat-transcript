// Task fields the user can edit before approving (title, description, owner,
// due date and Pending vs. Previous). Shared by the inline editor on the tasks page and
// the approval modal, so both edit the same draft the same way.
import { useTranslation } from "react-i18next";
import {
  type CloudActionItem,
  findNotionPerson,
  type ItemEdits,
  type NotionPersonOption,
  TASK_TYPE_PENDING,
  TASK_TYPE_PREVIOUS,
  WORK_TYPES,
} from "./shared";
import { DayMonthYearInput } from "@/components/ui/DayMonthYearInput";

/** Editable values of one task, as the form shows them. */
export interface TaskDraft {
  /** Name of the Notion card. */
  title: string;
  description: string;
  assignee: string;
  assignee_notion_user_id: string;
  assignee_email: string;
  /** "YYYY-MM-DD" or "" (no date). */
  due_date: string;
  task_type: string;
  /** One of `WORK_TYPES`, or "" when not classified. */
  work_type: string;
}

// Select values that aren't Notion user ids.
const NO_ASSIGNEE = "";
const UNLINKED_ASSIGNEE = "__unlinked__";

export const fieldLabel =
  "text-[10px] font-medium text-mid-gray uppercase tracking-wide";
export const fieldInput =
  "w-full px-2.5 py-1.5 text-sm rounded-md border bg-background focus:outline-none disabled:opacity-50";

/** A stored date as the date input's value ("YYYY-MM-DD"); "" when there is none. */
export function toInputDate(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

/** The form values for a saved task; a free-text owner is linked to its Notion person when it matches one. */
export function makeDraft(
  item: CloudActionItem,
  people: NotionPersonOption[],
): TaskDraft {
  const linked =
    people.find((p) => p.id === item.assignee_notion_user_id) ??
    (item.assignee ? findNotionPerson(item.assignee, people) : undefined);
  return {
    title: item.title ?? "",
    description: item.description ?? "",
    assignee: linked?.name ?? item.assignee ?? "",
    // Keep the saved person while the Notion people list isn't loaded yet.
    assignee_notion_user_id:
      linked?.id ??
      (people.length === 0 ? item.assignee_notion_user_id : "") ??
      "",
    assignee_email: linked?.email ?? "",
    due_date: toInputDate(item.due_date),
    task_type:
      item.task_type === TASK_TYPE_PREVIOUS
        ? TASK_TYPE_PREVIOUS
        : TASK_TYPE_PENDING,
    work_type: item.work_type ?? "",
  };
}

/** Whether the draft differs from what is saved for the task. */
export function isDraftDirty(
  draft: TaskDraft,
  item: CloudActionItem,
  people: NotionPersonOption[],
): boolean {
  const saved = makeDraft(item, people);
  return (Object.keys(saved) as (keyof TaskDraft)[]).some(
    (key) => saved[key] !== draft[key],
  );
}

/** Only the fields that changed against the saved task, as the backend expects them. */
export function draftEdits(draft: TaskDraft, item: CloudActionItem): ItemEdits {
  const changed: ItemEdits = {};
  if (draft.title !== (item.title ?? "") && draft.title.trim()) {
    changed.title = draft.title.trim();
  }
  if (draft.description !== (item.description ?? "")) {
    changed.description = draft.description;
  }
  if (draft.assignee_notion_user_id !== (item.assignee_notion_user_id ?? "")) {
    // Send the Notion user itself, not just its name, so the card gets the owner.
    changed.assignee = draft.assignee;
    changed.assignee_notion_user_id = draft.assignee_notion_user_id;
    changed.assignee_email = draft.assignee_email;
  } else if (draft.assignee !== (item.assignee ?? "")) {
    changed.assignee = draft.assignee;
  }
  if (draft.due_date !== toInputDate(item.due_date)) {
    changed.due_date = draft.due_date;
  }
  const savedType =
    item.task_type === TASK_TYPE_PREVIOUS
      ? TASK_TYPE_PREVIOUS
      : TASK_TYPE_PENDING;
  if (draft.task_type !== savedType) changed.task_type = draft.task_type;
  if (draft.work_type !== (item.work_type ?? "")) changed.work_type = draft.work_type;
  return changed;
}

/** The task as the backend stores it once `edits` are saved. */
export function applyEdits(
  item: CloudActionItem,
  edits: ItemEdits | undefined,
): CloudActionItem {
  if (!edits) return item;
  const next = { ...item };
  if (edits.title) next.title = edits.title;
  if (edits.description != null) next.description = edits.description;
  if (edits.assignee != null) {
    next.assignee = edits.assignee || null;
    // A free-text owner drops the Notion person (the backend does the same).
    next.assignee_notion_user_id = edits.assignee_notion_user_id || null;
  } else if (edits.assignee_notion_user_id != null) {
    next.assignee_notion_user_id = edits.assignee_notion_user_id || null;
  }
  if (edits.due_date != null) next.due_date = edits.due_date || null;
  if (edits.task_type != null) next.task_type = edits.task_type;
  if (edits.work_type != null) next.work_type = edits.work_type || null;
  return next;
}

/** i18n key of the first problem with the draft, or null when it can be saved. */
export function draftProblem(
  draft: TaskDraft,
  item: Pick<CloudActionItem, "title">,
): string | null {
  if (!draft.title.trim()) {
    // The title names the Notion card: it can be reworded, not removed.
    if (item.title?.trim()) return "actionItems.edit.titleRequired";
    // An old task without a title is only its description: it can't be left empty.
    if (!draft.description.trim()) return "actionItems.edit.descriptionRequired";
  }
  if (draft.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(draft.due_date)) {
    return "actionItems.edit.invalidDate";
  }
  return null;
}

/** The task title, i.e. the name its Notion card gets. */
export function TaskTitleInput({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (title: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={t("actionItems.edit.title")}
      title={t("actionItems.edit.titleHint")}
      placeholder={t("actionItems.edit.titlePlaceholder")}
      className={`${fieldInput} font-medium ${
        value.trim()
          ? "border-mid-gray/15 focus:border-lezat-sage/50"
          : "border-amber-500/50 focus:border-amber-500"
      }`}
    />
  );
}

/**
 * Description, owner, kind of work and due date of one task. The title is the separate
 * `TaskTitleInput` and Pending vs. Previous the `TaskTypeSwitch`, shown next to it.
 */
export function TaskFields({
  draft,
  people,
  onChange,
  disabled = false,
}: {
  draft: TaskDraft;
  people: NotionPersonOption[];
  onChange: (patch: Partial<TaskDraft>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const unlinkedOwner = !!draft.assignee && !draft.assignee_notion_user_id;

  const selectAssignee = (value: string) => {
    if (value === UNLINKED_ASSIGNEE) return;
    const person = people.find((p) => p.id === value);
    onChange({
      assignee: person?.name ?? "",
      assignee_notion_user_id: person?.id ?? "",
      assignee_email: person?.email ?? "",
    });
  };

  return (
    <>
      <textarea
        value={draft.description}
        onChange={(e) => onChange({ description: e.target.value })}
        disabled={disabled}
        rows={2}
        aria-label={t("actionItems.review.description")}
        className="w-full px-2.5 py-1.5 text-xs text-mid-gray rounded-md border border-mid-gray/15 bg-transparent resize-none focus:outline-none focus:border-lezat-sage/50 focus:text-text disabled:opacity-50"
        placeholder={t("actionItems.review.noDescription")}
      />

      <div className="flex flex-wrap gap-3">
        {/* Owner */}
        <label className="flex-[2] min-w-[180px] flex flex-col gap-1">
          <span className={fieldLabel}>{t("actionItems.review.assignee")}</span>
          {people.length > 0 ? (
            <>
              <select
                value={
                  draft.assignee_notion_user_id ||
                  (draft.assignee ? UNLINKED_ASSIGNEE : NO_ASSIGNEE)
                }
                onChange={(e) => selectAssignee(e.target.value)}
                disabled={disabled}
                className={`${fieldInput} ${
                  unlinkedOwner
                    ? "border-amber-500/50 focus:border-amber-500"
                    : "border-mid-gray/15 focus:border-lezat-sage/50"
                }`}
              >
                <option value={NO_ASSIGNEE}>
                  {t("actionItems.review.noAssignee")}
                </option>
                {unlinkedOwner && (
                  <option value={UNLINKED_ASSIGNEE}>
                    {t("actionItems.review.notInNotion", {
                      name: draft.assignee,
                    })}
                  </option>
                )}
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
              {unlinkedOwner && (
                <span className="text-[10px] text-amber-500">
                  {t("actionItems.review.notInNotionHint")}
                </span>
              )}
            </>
          ) : (
            <input
              type="text"
              value={draft.assignee}
              onChange={(e) =>
                onChange({
                  assignee: e.target.value,
                  assignee_notion_user_id: "",
                  assignee_email: "",
                })
              }
              disabled={disabled}
              className={`${fieldInput} border-mid-gray/15 focus:border-lezat-sage/50`}
            />
          )}
        </label>

        {/* Kind of work: where the team's effort goes */}
        <label className="flex-1 min-w-[140px] flex flex-col gap-1">
          <span className={fieldLabel}>{t("actionItems.workType.label")}</span>
          <select
            value={draft.work_type}
            onChange={(e) => onChange({ work_type: e.target.value })}
            disabled={disabled}
            title={t("actionItems.workType.hint")}
            className={`${fieldInput} border-mid-gray/15 focus:border-lezat-sage/50`}
          >
            <option value="">{t("actionItems.workType.none")}</option>
            {WORK_TYPES.map((key) => (
              <option key={key} value={key}>
                {t(`actionItems.workType.${key}`)}
              </option>
            ))}
          </select>
        </label>

        {/* Due date (optional); a task already done has none, it goes to the timesheet */}
        {draft.task_type === TASK_TYPE_PREVIOUS ? (
          <p className="flex-1 min-w-[140px] self-end pb-1.5 text-[11px] text-blue-500">
            {t("actionItems.review.doneForTimesheet")}
          </p>
        ) : (
          <label className="flex-1 min-w-[140px] flex flex-col gap-1">
            <span className={fieldLabel}>
              {t("actionItems.review.dueDateOptional")}
            </span>
            <DayMonthYearInput
              value={draft.due_date}
              onChange={(due_date) => onChange({ due_date })}
              disabled={disabled}
              className={`${fieldInput} border-mid-gray/15 focus:border-lezat-sage/50`}
            />
          </label>
        )}
      </div>
    </>
  );
}

/** Two-option switch: still to do vs. already done before the meeting. */
export function TaskTypeSwitch({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const options = [
    { value: TASK_TYPE_PENDING, label: t("actionItems.review.typePending") },
    { value: TASK_TYPE_PREVIOUS, label: t("actionItems.previousTask") },
  ];
  return (
    <div
      role="radiogroup"
      title={t("actionItems.review.typeHint")}
      className="shrink-0 flex rounded-full border border-mid-gray/20 p-0.5 text-[10px] font-medium"
    >
      {options.map((opt) => {
        const active = value === opt.value;
        const activeClass =
          opt.value === TASK_TYPE_PREVIOUS
            ? "bg-blue-500/15 text-blue-500"
            : "bg-lezat-sage/20 text-text";
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`px-2 py-0.5 rounded-full transition-colors disabled:opacity-50 ${
              active ? activeClass : "text-mid-gray hover:text-text"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
