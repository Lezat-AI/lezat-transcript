import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  Check,
  Database,
  Loader2,
  RotateCcw,
  Send,
  Video,
  X,
} from "lucide-react";
import {
  CALENDAR_TARGETS,
  type CloudActionItem,
  findNotionPerson,
  type IntegrationInfo,
  type ItemEdits,
  type PreloadedConfig,
  TASK_TYPE_PENDING,
  TASK_TYPE_PREVIOUS,
} from "./shared";

interface EditableItem {
  id: string;
  title: string;
  description: string;
  assignee: string;
  assignee_notion_user_id: string;
  assignee_email: string;
  due_date: string;
  task_type: string;
  meeting_title: string;
  /** Groups tasks by meeting: two meetings can share a title ("Daily"). */
  meeting_key: string;
  /** Board the backend suggested for this task ("" = none). */
  suggested_board_id: string;
  suggested_board_title: string;
  suggested_board_reason: string;
  /** false once the user sends this one task to the general board instead. */
  use_suggested_board: boolean;
}

type EditableField =
  | "description"
  | "assignee"
  | "due_date"
  | "task_type"
  | "use_suggested_board";

// Select values that aren't Notion user ids.
const NO_ASSIGNEE = "";
const UNLINKED_ASSIGNEE = "__unlinked__";

/** Integrations that can't receive approved tasks from here. */
const NON_TARGET_PROVIDERS = ["read-ai", "monday", "fireflies"];

const TARGET_LABELS: Record<string, string> = {
  notion: "Notion",
  "google-calendar": "Google Calendar",
  "outlook-calendar": "Outlook",
};

const fieldLabel =
  "text-[10px] font-medium text-mid-gray uppercase tracking-wide";
const fieldInput =
  "w-full px-2.5 py-1.5 text-sm rounded-md border bg-background focus:outline-none";

/**
 * Review step before approving tasks.
 *
 * Layout, top to bottom:
 *  1. Where the tasks go (Notion / calendars). Checking Notion reveals the one
 *     board picker (plus the column for new cards).
 *  2. The tasks, grouped by meeting: owner, due date and Pending vs. Previous.
 *     A task only shows a board when the backend suggested a *different* one
 *     than the general pick; the user can keep that suggestion or drop it.
 *  3. Warnings and the approve button.
 */
/** A stored date as the date input's value ("YYYY-MM-DD"); "" when there is none. */
function toInputDate(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

export function ApprovalReviewModal({
  items,
  integrations,
  config,
  onConfirm,
  onClose,
}: {
  items: CloudActionItem[];
  integrations: IntegrationInfo[];
  config: PreloadedConfig;
  onConfirm: (
    edits: Record<string, ItemEdits>,
    integrationSettings: Record<string, string>,
    syncTargets: string[],
  ) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [editableItems, setEditableItems] = useState<EditableItem[]>(() =>
    items.map((i) => {
      const linked =
        config.notionPeople.find((p) => p.id === i.assignee_notion_user_id) ??
        (i.assignee
          ? findNotionPerson(i.assignee, config.notionPeople)
          : undefined);
      return {
        id: i.id,
        title: i.title ?? "",
        description: i.description ?? "",
        assignee: linked?.name ?? i.assignee ?? "",
        assignee_notion_user_id: linked?.id ?? "",
        assignee_email: linked?.email ?? "",
        due_date: toInputDate(i.due_date),
        task_type:
          i.task_type === TASK_TYPE_PREVIOUS
            ? TASK_TYPE_PREVIOUS
            : TASK_TYPE_PENDING,
        meeting_title:
          i.meeting_name ?? i.meeting_title ?? t("actionItems.untitledMeeting"),
        meeting_key: i.meeting_id ?? i.meeting_name ?? i.meeting_title ?? "",
        suggested_board_id: i.notion_database_id ?? "",
        suggested_board_title: i.notion_database_title ?? "",
        suggested_board_reason: i.notion_database_reason ?? "",
        use_suggested_board: true,
      };
    }),
  );
  const [submitting, setSubmitting] = useState(false);

  // ── Destinations ──
  const connected = integrations.filter(
    (i) => i.connected && !NON_TARGET_PROVIDERS.includes(i.provider),
  );
  // Calendars start unchecked: events are only created when the user asks for them.
  const [targets, setTargets] = useState<Set<string>>(
    () =>
      new Set(
        connected
          .map((i) => i.provider)
          .filter((p) => !CALENDAR_TARGETS.includes(p)),
      ),
  );
  const notionConfig = integrations.find(
    (i) => i.provider === "notion",
  )?.config;
  const [notionDbId, setNotionDbId] = useState(notionConfig?.database_id ?? "");
  // Notion column for the tasks still to do. Tasks already done (reported in a
  // daily standup) always go to the board's Done column.
  const [notionStatus, setNotionStatus] = useState(
    notionConfig?.todo_status ?? "",
  );
  const [useSuggestedBoards, setUseSuggestedBoards] = useState(true);

  const sendsToNotion = targets.has("notion");
  const boardsLoaded = config.notionDbs.length > 0;
  const notionStatusOpts = config.notionStatuses[notionDbId] ?? [];

  const boardName = (id: string, fallback = "") =>
    config.notionDbs.find((db) => db.id === id)?.name || fallback || "—";
  const generalBoardName = boardName(notionDbId);

  const toggleTarget = (p: string) =>
    setTargets((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  // ── Per-task boards ──
  /** The backend suggested a board other than the general one for this task. */
  const hasOtherSuggestion = (item: EditableItem) =>
    !!item.suggested_board_id && item.suggested_board_id !== notionDbId;
  const suggestedCount = editableItems.filter(hasOtherSuggestion).length;
  const goesToSuggested = (item: EditableItem) =>
    useSuggestedBoards && item.use_suggested_board && hasOtherSuggestion(item);
  const effectiveBoard = (item: EditableItem) =>
    goesToSuggested(item) ? item.suggested_board_id : notionDbId;

  // ── Item edits ──
  const updateItem = <K extends EditableField>(
    id: string,
    field: K,
    value: EditableItem[K],
  ) => {
    setEditableItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    );
  };

  const selectAssignee = (id: string, value: string) => {
    if (value === UNLINKED_ASSIGNEE) return;
    const person = config.notionPeople.find((p) => p.id === value);
    setEditableItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              assignee: person?.name ?? "",
              assignee_notion_user_id: person?.id ?? "",
              assignee_email: person?.email ?? "",
            }
          : item,
      ),
    );
  };

  const previousCount = editableItems.filter(
    (i) => i.task_type === TASK_TYPE_PREVIOUS,
  ).length;

  // ── Validation ──
  const requiresDate = CALENDAR_TARGETS.some((p) => targets.has(p));
  const itemsMissingDate = requiresDate
    ? editableItems.filter(
        (i) => !i.due_date && i.task_type !== TASK_TYPE_PREVIOUS,
      ).length
    : 0;
  // Only block when the board list is loaded; otherwise the backend default applies.
  const itemsMissingBoard =
    sendsToNotion && boardsLoaded
      ? editableItems.filter((i) => !effectiveBoard(i)).length
      : 0;
  const canConfirm = !submitting && targets.size > 0 && itemsMissingBoard === 0;

  const handleConfirm = () => {
    setSubmitting(true);
    const edits: Record<string, ItemEdits> = {};
    for (const edited of editableItems) {
      const original = items.find((i) => i.id === edited.id);
      if (!original) continue;
      const changed: ItemEdits = {};
      if (edited.description !== (original.description ?? "")) {
        changed.description = edited.description;
      }
      if (
        edited.assignee_notion_user_id !==
        (original.assignee_notion_user_id ?? "")
      ) {
        // Send the Notion user itself, not just its name, so the card gets the owner.
        changed.assignee = edited.assignee;
        changed.assignee_notion_user_id = edited.assignee_notion_user_id;
        changed.assignee_email = edited.assignee_email;
      } else if (edited.assignee !== (original.assignee ?? "")) {
        changed.assignee = edited.assignee;
      }
      if (edited.due_date !== toInputDate(original.due_date))
        changed.due_date = edited.due_date;
      // Always sent, so the backend knows whether the card is still to do.
      changed.task_type = edited.task_type;
      if (
        sendsToNotion &&
        notionStatus &&
        edited.task_type !== TASK_TYPE_PREVIOUS
      )
        changed.notion_status = notionStatus;
      // Each task goes to its suggested board (if kept) or the general one.
      const board = effectiveBoard(edited);
      if (sendsToNotion && board) changed.notion_database_id = board;
      edits[edited.id] = changed;
    }
    const integrationSettings: Record<string, string> = {};
    if (sendsToNotion) {
      if (notionDbId)
        integrationSettings["NOTION_TASKS_DATABASE_ID"] = notionDbId;
      if (notionStatus)
        integrationSettings["NOTION_KANBAN_TODO_STATUS"] = notionStatus;
    }
    onConfirm(edits, integrationSettings, Array.from(targets));
  };

  const groupedByMeeting = useMemo(() => {
    const map = new Map<string, EditableItem[]>();
    for (const item of editableItems) {
      const list = map.get(item.meeting_key);
      if (list) list.push(item);
      else map.set(item.meeting_key, [item]);
    }
    return Array.from(map.entries());
  }, [editableItems]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-xl shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-mid-gray/20">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">
              {t("actionItems.review.title", { count: items.length })}
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-mid-gray/10"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-mid-gray mt-1">
            {t("actionItems.review.subtitle")}
          </p>
        </div>

        {/* Destinations and tasks scroll together so small windows still show the tasks. */}
        <div className="flex-1 overflow-y-auto">
          {/* 1. Destinations — the only place to pick the Notion board */}
          <div className="px-6 py-4 border-b border-mid-gray/20 flex flex-col gap-3">
            <p className="text-xs font-semibold">
              {t("actionItems.review.destination")}
            </p>
            {connected.length === 0 ? (
              <p className="text-[11px] text-mid-gray">
                {t("actionItems.approval.noIntegrations")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {connected.map((integration) => {
                  const checked = targets.has(integration.provider);
                  return (
                    <button
                      key={integration.provider}
                      type="button"
                      aria-pressed={checked}
                      onClick={() => toggleTarget(integration.provider)}
                      className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                        checked
                          ? "border-lezat-sage/60 bg-lezat-sage/15 text-text"
                          : "border-mid-gray/20 text-mid-gray hover:bg-mid-gray/10"
                      }`}
                    >
                      <span
                        className={`flex items-center justify-center w-3.5 h-3.5 rounded-sm border ${
                          checked
                            ? "bg-lezat-sage border-lezat-sage"
                            : "border-mid-gray/40"
                        }`}
                      >
                        {checked && (
                          <Check className="w-2.5 h-2.5 text-[#0d0d1a]" />
                        )}
                      </span>
                      {TARGET_LABELS[integration.provider] ??
                        integration.provider}
                    </button>
                  );
                })}
              </div>
            )}

            {sendsToNotion && (
              <div className="rounded-lg bg-mid-gray/[0.06] px-3 py-3 flex flex-col gap-2">
                <div className="flex flex-wrap gap-3">
                  <label className="flex-1 min-w-[180px] flex flex-col gap-1">
                    <span className={fieldLabel}>
                      {t("actionItems.review.notionBoard")}
                    </span>
                    {boardsLoaded ? (
                      <select
                        value={notionDbId}
                        onChange={(e) => setNotionDbId(e.target.value)}
                        className={`${fieldInput} ${
                          notionDbId
                            ? "border-mid-gray/15 focus:border-lezat-sage/50"
                            : "border-amber-500/50 focus:border-amber-500"
                        }`}
                      >
                        <option value="">
                          {t("actionItems.review.chooseBoard")}
                        </option>
                        {config.notionDbs.map((db) => (
                          <option key={db.id} value={db.id}>
                            {db.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="flex items-center gap-1.5 py-1.5 text-xs text-mid-gray">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t("actionItems.review.loadingBoards")}
                      </span>
                    )}
                  </label>
                  {notionStatusOpts.length > 0 && (
                    <label className="flex-1 min-w-[160px] flex flex-col gap-1">
                      <span className={fieldLabel}>
                        {t("actionItems.review.notionStatus")}
                      </span>
                      <select
                        value={notionStatus}
                        onChange={(e) => setNotionStatus(e.target.value)}
                        className={`${fieldInput} border-mid-gray/15 focus:border-lezat-sage/50`}
                      >
                        <option value="">
                          {t("actionItems.review.statusDefault")}
                        </option>
                        {notionStatusOpts.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <p className="text-[10px] text-mid-gray">
                  {t("actionItems.review.boardRemembered")}
                </p>
                {previousCount > 0 && (
                  <p className="text-[11px] text-blue-500 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    {t("actionItems.review.doneGoToDone", {
                      count: previousCount,
                    })}
                  </p>
                )}

                {suggestedCount > 0 && (
                  <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={useSuggestedBoards}
                      onChange={(e) => setUseSuggestedBoards(e.target.checked)}
                      className="mt-0.5 accent-lezat-sage"
                    />
                    <span className="flex flex-col">
                      <span className="text-xs">
                        {t("actionItems.review.useSuggested", {
                          count: suggestedCount,
                        })}
                      </span>
                      {notionDbId && (
                        <span className="text-[10px] text-mid-gray">
                          {t("actionItems.review.useSuggestedHint", {
                            name: generalBoardName,
                          })}
                        </span>
                      )}
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>

          {/* 2. Tasks */}
          <div className="px-6 py-4 flex flex-col gap-4">
            {groupedByMeeting.map(([meetingKey, meetingItems]) => (
              <div key={meetingKey}>
                <div className="flex items-center gap-2 mb-2">
                  <Video className="w-3.5 h-3.5 text-mid-gray" />
                  <span className="text-xs font-medium text-mid-gray">
                    {meetingItems[0].meeting_title}
                  </span>
                </div>
                <div className="flex flex-col gap-3">
                  {[TASK_TYPE_PENDING, TASK_TYPE_PREVIOUS].map((type) => {
                    const section = meetingItems.filter((i) =>
                      type === TASK_TYPE_PREVIOUS
                        ? i.task_type === TASK_TYPE_PREVIOUS
                        : i.task_type !== TASK_TYPE_PREVIOUS,
                    );
                    if (section.length === 0) return null;
                    const isDone = type === TASK_TYPE_PREVIOUS;
                    return (
                      <div key={type} className="flex flex-col gap-3">
                        {previousCount > 0 && (
                          <p
                            className={`text-[10px] font-semibold uppercase tracking-wide ${
                              isDone ? "text-blue-500" : "text-mid-gray"
                            }`}
                          >
                            {isDone
                              ? t("actionItems.review.sectionDone", {
                                  count: section.length,
                                })
                              : t("actionItems.review.sectionTodo", {
                                  count: section.length,
                                })}
                          </p>
                        )}
                        {section.map((item) => (
                          <TaskCard
                            key={item.id}
                            item={item}
                            config={config}
                            showBoard={
                              sendsToNotion &&
                              useSuggestedBoards &&
                              hasOtherSuggestion(item)
                            }
                            suggestedBoardName={boardName(
                              item.suggested_board_id,
                              item.suggested_board_title,
                            )}
                            generalBoardName={generalBoardName}
                            onChange={updateItem}
                            onSelectAssignee={selectAssignee}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 3. Warnings + actions */}
        <div className="px-6 py-4 border-t border-mid-gray/20 flex flex-col gap-3">
          {itemsMissingBoard > 0 && (
            <p className="text-[11px] text-amber-500 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {t("actionItems.review.missingBoard")}
            </p>
          )}
          {targets.size === 0 && connected.length > 0 && (
            <p className="text-[11px] text-amber-500 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {t("actionItems.review.noTargets")}
            </p>
          )}
          {/* Tasks without a date skip the calendar (the date is optional) */}
          {itemsMissingDate > 0 && (
            <p className="text-[11px] text-amber-500 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {t("actionItems.review.dateMissingCalendar", {
                count: itemsMissingDate,
              })}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/10 transition-colors"
            >
              {t("actionItems.review.cancel")}
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 disabled:opacity-50 transition-colors"
            >
              {submitting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              {submitting
                ? t("actionItems.review.confirming")
                : t("actionItems.review.confirm", { count: items.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── One task in the review list ─────────────────────────────────

function TaskCard({
  item,
  config,
  showBoard,
  suggestedBoardName,
  generalBoardName,
  onChange,
  onSelectAssignee,
}: {
  item: EditableItem;
  config: PreloadedConfig;
  /** The task has its own suggested board (different from the general one). */
  showBoard: boolean;
  suggestedBoardName: string;
  generalBoardName: string;
  onChange: <K extends EditableField>(
    id: string,
    field: K,
    value: EditableItem[K],
  ) => void;
  onSelectAssignee: (id: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const unlinkedOwner = !!item.assignee && !item.assignee_notion_user_id;

  return (
    <div className="rounded-lg border border-mid-gray/15 p-3 flex flex-col gap-2.5">
      {/* Title + Pending / Previous */}
      <div className="flex items-start gap-3">
        <p className="flex-1 min-w-0 text-sm font-medium">
          {item.title || item.description || "—"}
        </p>
        <TaskTypeSwitch
          value={item.task_type}
          onChange={(value) => onChange(item.id, "task_type", value)}
        />
      </div>

      <textarea
        value={item.description}
        onChange={(e) => onChange(item.id, "description", e.target.value)}
        rows={2}
        aria-label={t("actionItems.review.description")}
        className="w-full px-2.5 py-1.5 text-xs text-mid-gray rounded-md border border-mid-gray/15 bg-transparent resize-none focus:outline-none focus:border-lezat-sage/50 focus:text-text"
        placeholder={t("actionItems.review.noDescription")}
      />

      <div className="flex flex-wrap gap-3">
        {/* Owner */}
        <label className="flex-[2] min-w-[180px] flex flex-col gap-1">
          <span className={fieldLabel}>{t("actionItems.review.assignee")}</span>
          {config.notionPeople.length > 0 ? (
            <>
              <select
                value={
                  item.assignee_notion_user_id ||
                  (item.assignee ? UNLINKED_ASSIGNEE : NO_ASSIGNEE)
                }
                onChange={(e) => onSelectAssignee(item.id, e.target.value)}
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
                      name: item.assignee,
                    })}
                  </option>
                )}
                {config.notionPeople.map((person) => (
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
              value={item.assignee}
              onChange={(e) => onChange(item.id, "assignee", e.target.value)}
              className={`${fieldInput} border-mid-gray/15 focus:border-lezat-sage/50`}
            />
          )}
        </label>

        {/* Due date (optional); a task already done has none, it goes to the timesheet */}
        {item.task_type === TASK_TYPE_PREVIOUS ? (
          <p className="flex-1 min-w-[140px] self-end pb-1.5 text-[11px] text-blue-500">
            {t("actionItems.review.doneForTimesheet")}
          </p>
        ) : (
          <label className="flex-1 min-w-[140px] flex flex-col gap-1">
            <span className={fieldLabel}>
              {t("actionItems.review.dueDateOptional")}
            </span>
            <input
              type="date"
              lang="es"
              value={item.due_date}
              onChange={(e) => onChange(item.id, "due_date", e.target.value)}
              className={`${fieldInput} border-mid-gray/15 focus:border-lezat-sage/50`}
            />
          </label>
        )}
      </div>

      {/* Own board: only when the suggestion differs from the general board */}
      {showBoard &&
        (item.use_suggested_board ? (
          <div className="flex items-center gap-1.5 text-[11px]">
            <span
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-lezat-sage/15 text-text"
              title={item.suggested_board_reason || undefined}
            >
              <Database className="w-3 h-3 text-lezat-sage" />
              {t("actionItems.review.goesToBoard", {
                name: suggestedBoardName,
              })}
              <span className="text-mid-gray">
                {t("actionItems.review.suggested")}
              </span>
              <button
                type="button"
                onClick={() => onChange(item.id, "use_suggested_board", false)}
                title={t("actionItems.review.sendToGeneral", {
                  name: generalBoardName,
                })}
                aria-label={t("actionItems.review.sendToGeneral", {
                  name: generalBoardName,
                })}
                className="ml-0.5 p-0.5 rounded-full hover:bg-mid-gray/20"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onChange(item.id, "use_suggested_board", true)}
            className="self-start flex items-center gap-1 text-[11px] text-mid-gray hover:text-text"
          >
            <RotateCcw className="w-3 h-3" />
            {t("actionItems.review.useSuggestedFor", {
              name: suggestedBoardName,
            })}
          </button>
        ))}
    </div>
  );
}

/** Two-option switch: still to do vs. already done before the meeting. */
function TaskTypeSwitch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
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
            onClick={() => onChange(opt.value)}
            className={`px-2 py-0.5 rounded-full transition-colors ${
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
