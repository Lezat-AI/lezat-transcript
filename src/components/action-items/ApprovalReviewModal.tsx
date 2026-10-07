import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  Check,
  Loader2,
  Send,
  Video,
  X,
} from "lucide-react";
import {
  CALENDAR_TARGETS,
  type CloudActionItem,
  type IntegrationInfo,
  type ItemEdits,
  type PreloadedConfig,
  TASK_TYPE_PENDING,
  TASK_TYPE_PREVIOUS,
} from "./shared";
import {
  draftEdits,
  draftProblem,
  fieldInput,
  fieldLabel,
  makeDraft,
  type TaskDraft,
  TaskFields,
  TaskTypeSwitch,
} from "./TaskEditor";

interface EditableItem extends TaskDraft {
  id: string;
  title: string;
  meeting_title: string;
  /** Groups tasks by meeting: two meetings can share a title ("Daily"). */
  meeting_key: string;
}

/** Integrations that can't receive approved tasks from here. */
const NON_TARGET_PROVIDERS = ["read-ai", "monday", "fireflies"];

const TARGET_LABELS: Record<string, string> = {
  notion: "Notion",
  "google-calendar": "Google Calendar",
  "outlook-calendar": "Outlook",
};

/**
 * Review step before approving tasks.
 *
 * Tasks can already be edited on the tasks page; this window starts from those
 * values (saved, or still being edited there) so only last-minute changes are
 * left to make here.
 *
 * Layout, top to bottom:
 *  1. Where the tasks go (Notion / calendars). Checking Notion reveals the one
 *     board picker (plus the column for new cards).
 *  2. The tasks, grouped by meeting: owner, due date and Pending vs. Previous.
 *     Every task goes to the board picked here: never to a suggested one.
 *  3. Warnings and the approve button.
 */
export function ApprovalReviewModal({
  items,
  drafts,
  integrations,
  config,
  onExclude,
  onConfirm,
  onClose,
}: {
  items: CloudActionItem[];
  /** Edits made on the tasks page and not saved yet, by task id. */
  drafts?: Record<string, TaskDraft>;
  integrations: IntegrationInfo[];
  config: PreloadedConfig;
  /** Leave a task out of this approval (it stays pending on the page). */
  onExclude?: (id: string) => void;
  onConfirm: (
    edits: Record<string, ItemEdits>,
    integrationSettings: Record<string, string>,
    syncTargets: string[],
  ) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [allEditableItems, setEditableItems] = useState<EditableItem[]>(() =>
    items.map((i) => ({
      ...(drafts?.[i.id] ?? makeDraft(i, config.notionPeople)),
      id: i.id,
      title: i.title ?? "",
      meeting_title:
        i.meeting_name ?? i.meeting_title ?? t("actionItems.untitledMeeting"),
      meeting_key: i.meeting_id ?? i.meeting_name ?? i.meeting_title ?? "",
    })),
  );
  // Tasks left out of the approval disappear from this window.
  const editableItems = useMemo(() => {
    const ids = new Set(items.map((i) => i.id));
    return allEditableItems.filter((e) => ids.has(e.id));
  }, [allEditableItems, items]);
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

  const sendsToNotion = targets.has("notion");
  const boardsLoaded = config.notionDbs.length > 0;
  const notionStatusOpts = config.notionStatuses[notionDbId] ?? [];


  const toggleTarget = (p: string) =>
    setTargets((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  // ── Item edits ──
  const updateItem = (id: string, patch: Partial<TaskDraft>) => {
    setEditableItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
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
  // Notion needs a board picked by the user: no board, no approval.
  const itemsMissingBoard = sendsToNotion && !notionDbId ? editableItems.length : 0;
  const itemsInvalid = editableItems.filter(
    (i) => draftProblem(i, i) !== null,
  ).length;
  const canConfirm =
    !submitting &&
    editableItems.length > 0 &&
    targets.size > 0 &&
    itemsMissingBoard === 0 &&
    itemsInvalid === 0;

  const handleConfirm = () => {
    setSubmitting(true);
    const edits: Record<string, ItemEdits> = {};
    for (const edited of editableItems) {
      const original = items.find((i) => i.id === edited.id);
      if (!original) continue;
      const changed: ItemEdits = draftEdits(edited, original);
      // Always sent, so the backend knows whether the card is still to do.
      changed.task_type = edited.task_type;
      if (
        sendsToNotion &&
        notionStatus &&
        edited.task_type !== TASK_TYPE_PREVIOUS
      )
        changed.notion_status = notionStatus;
      // Always the board picked in this window.
      const board = notionDbId;
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
              {t("actionItems.review.title", { count: editableItems.length })}
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
                            onChange={updateItem}
                            onExclude={
                              onExclude && editableItems.length > 1
                                ? onExclude
                                : undefined
                            }
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
          {itemsInvalid > 0 && (
            <p className="text-[11px] text-amber-500 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {t("actionItems.review.invalidItems", { count: itemsInvalid })}
            </p>
          )}
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
                : t("actionItems.review.confirm", { count: editableItems.length })}
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
  onChange,
  onExclude,
}: {
  item: EditableItem;
  config: PreloadedConfig;
  onChange: (id: string, patch: Partial<TaskDraft>) => void;
  onExclude?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const problem = draftProblem(item, item);

  return (
    <div className="rounded-lg border border-mid-gray/15 p-3 flex flex-col gap-2.5">
      {/* Title + Pending / Previous */}
      <div className="flex items-start gap-3">
        <p className="flex-1 min-w-0 text-sm font-medium">
          {item.title || item.description || "—"}
        </p>
        <TaskTypeSwitch
          value={item.task_type}
          onChange={(value) => onChange(item.id, { task_type: value })}
        />
        {onExclude && (
          <button
            type="button"
            onClick={() => onExclude(item.id)}
            className="shrink-0 p-0.5 rounded text-mid-gray hover:text-red-500 hover:bg-red-500/10 transition-colors"
            title={t("actionItems.review.exclude")}
            aria-label={t("actionItems.review.exclude")}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <TaskFields
        draft={item}
        people={config.notionPeople}
        onChange={(patch) => onChange(item.id, patch)}
      />

      {problem && (
        <p className="text-[11px] text-amber-500 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {t(problem)}
        </p>
      )}
    </div>
  );
}
