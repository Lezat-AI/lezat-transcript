import React, { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { ApprovalReviewModal } from "./ApprovalReviewModal";
import { groupByProject, PROJECT_OPTIONS, resolveProject } from "./projects";
import {
  CALENDAR_TARGETS,
  type CloudActionItem,
  formatDate,
  type IntegrationInfo,
  type ItemEdits,
  type PreloadedConfig,
  type SelectOption,
  TASK_TYPE_PREVIOUS,
} from "./shared";

import {
  CheckCircle2,
  RefreshCw,
  Loader2,
  AlertCircle,
  CloudOff,
  ChevronDown,
  ChevronRight,
  Video,
  X,
  Send,
  Database,
  CheckSquare,
  Square,
  MinusSquare,
  ChevronsDown,
  Clock,
  Check,
  Pencil,
  Trash2,
  User,
  CalendarDays,
  Folder,
} from "lucide-react";

interface MeetingGroup {
  meeting_id: string;
  meeting_title: string;
  items: CloudActionItem[];
  completed: number;
  total: number;
}

// ─── Timesheet Dialog ───────────────────────────────────────────

interface TimesheetProject {
  id: number;
  name: string;
  client_name: string;
}

function parseHoursInput(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const direct = parseFloat(trimmed);
  if (/^\d+(\.\d+)?$/.test(trimmed) && !isNaN(direct) && direct > 0) return direct;
  const hMatch = trimmed.match(/(\d+)\s*h/);
  const mMatch = trimmed.match(/(\d+)\s*m/);
  if (hMatch || mMatch) {
    const h = hMatch ? parseInt(hMatch[1], 10) : 0;
    const m = mMatch ? parseInt(mMatch[1], 10) : 0;
    const total = h + m / 60;
    return total > 0 ? Math.round(total * 100) / 100 : null;
  }
  return null;
}

function formatHoursPreview(input: string): string | null {
  const hours = parseHoursInput(input);
  if (hours === null) return null;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return null;
}

function AiButton({ onClick, loading, title }: { onClick: () => void; loading: boolean; title: string }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      title={title}
      className="shrink-0 p-1.5 rounded-lg border border-purple-400/30 text-purple-500 hover:bg-purple-500/10 disabled:opacity-40 transition-colors"
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1l1.5 3.5L13 6l-3.5 1.5L8 11 6.5 7.5 3 6l3.5-1.5zM3 11l.75 1.75L5.5 13.5l-1.75.75L3 16l-.75-1.75L.5 13.5l1.75-.75z" />
        </svg>
      )}
    </button>
  );
}

interface TimesheetDialogProps {
  descriptions: string[];
  taskIds: string[];
  /** When set, dialog opens in edit mode for this entry */
  editEntryId?: number;
  onClose: () => void;
  /** Called after a successful create with the new entry ID */
  onCreated?: (entryId: number) => void;
  /** Called after a successful delete */
  onDeleted?: (entryId: number) => void;
  /** Called after a successful update */
  onUpdated?: (entryId: number) => void;
}

function TimesheetDialog({
  descriptions,
  taskIds,
  editEntryId,
  onClose,
  onCreated,
  onDeleted,
  onUpdated,
}: TimesheetDialogProps) {
  const { t } = useTranslation();
  const { settings, refreshSettings } = useSettings();

  const isEditMode = editEntryId != null;

  const [projects, setProjects] = useState<TimesheetProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingEntry, setLoadingEntry] = useState(isEditMode);
  const [entryStatus, setEntryStatus] = useState<string>("pending");
  const [projectId, setProjectId] = useState<number | null>(
    settings?.timesheet_default_project_id ?? null,
  );
  const [hoursInput, setHoursInput] = useState("");
  const [description, setDescription] = useState(() => descriptions.join("\n"));
  const today = new Date();
  const [day, setDay] = useState(today.getDate());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiLoadingFields, setAiLoadingFields] = useState<Set<string>>(new Set());
  const [sessionExpired, setSessionExpired] = useState(false);

  const isApproved = entryStatus === "approved";

  // Fetch projects
  useEffect(() => {
    (commands as any).timesheetGetProjects().then((r: any) => {
      if (r.status === "ok") {
        setProjects(r.data);
      } else {
        const err = r.error ?? "";
        if (err.includes("session_expired")) {
          setSessionExpired(true);
          (commands as any).timesheetDisconnect().then(() => refreshSettings()).catch(() => {});
        } else {
          setError(err || "Failed to load projects");
        }
      }
    }).catch((e: unknown) => setError(String(e))).finally(() => setLoadingProjects(false));
  }, [refreshSettings]);

  // In edit mode, fetch existing entry to pre-fill and get status
  useEffect(() => {
    if (!editEntryId) return;
    (commands as any).timesheetGetEntry(editEntryId).then((r: any) => {
      if (r.status === "ok") {
        const entry = r.data;
        setProjectId(entry.project_id);
        setHoursInput(entry.hours);
        setDescription(entry.description);
        setEntryStatus(entry.status);
        // Parse date YYYY-MM-DD
        const parts = (entry.date as string).split("-");
        if (parts.length === 3) {
          setYear(Number(parts[0]));
          setMonth(Number(parts[1]));
          setDay(Number(parts[2]));
        }
      } else {
        setError(r.error ?? "Failed to load entry");
      }
    }).catch((e: unknown) => setError(String(e))).finally(() => setLoadingEntry(false));
  }, [editEntryId]);

  const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const daysInMonth = new Date(year, month, 0).getDate();

  const addAiLoading = (key: string) => setAiLoadingFields((prev) => new Set(prev).add(key));
  const removeAiLoading = (key: string) => setAiLoadingFields((prev) => { const next = new Set(prev); next.delete(key); return next; });

  const handleAiSuggest = async () => {
    if (descriptions.length === 0 || projects.length === 0) return;
    addAiLoading("all");
    setError(null);
    try {
      const projectsJson = JSON.stringify(
        projects.map((p) => ({ id: p.id, name: p.name, client: p.client_name })),
      );
      const r = await (commands as any).timesheetAiSuggest(descriptions, projectsJson);
      if (r.status === "ok") {
        const suggestion = r.data;
        if (suggestion.project_id != null) setProjectId(suggestion.project_id);
        if (suggestion.hours != null) setHoursInput(String(suggestion.hours));
        if (suggestion.description) setDescription(suggestion.description);
      } else {
        setError(r.error ?? "AI suggestion failed");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      removeAiLoading("all");
    }
  };

  const handleAiField = async (field: "project" | "hours" | "description") => {
    if (descriptions.length === 0) return;
    addAiLoading(field);
    setError(null);
    try {
      const projectsJson = JSON.stringify(
        projects.map((p) => ({ id: p.id, name: p.name, client: p.client_name })),
      );
      const r = await (commands as any).timesheetAiSuggest(descriptions, projectsJson);
      if (r.status === "ok") {
        const s = r.data;
        if (field === "project" && s.project_id != null) setProjectId(s.project_id);
        if (field === "hours" && s.hours != null) setHoursInput(String(s.hours));
        if (field === "description" && s.description) setDescription(s.description);
      } else {
        setError(r.error ?? "AI suggestion failed");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      removeAiLoading(field);
    }
  };

  const handleSubmit = async () => {
    const hours = parseHoursInput(hoursInput);
    if (!hours || !projectId || !description.trim() || !isoDate) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isEditMode) {
        const r = await (commands as any).timesheetUpdateEntry(
          editEntryId, projectId, isoDate, hours, description.trim(),
        );
        if (r.status === "ok") {
          setSuccess(t("integrations.timesheet.updateSuccess"));
          onUpdated?.(editEntryId!);
          setTimeout(() => onClose(), 1200);
        } else {
          setError(r.error ?? "Failed to update entry");
        }
      } else {
        const r = await (commands as any).timesheetCreateEntry(
          projectId, isoDate, hours, description.trim(),
        );
        if (r.status === "ok") {
          const newId: number = r.data.id;
          // Save task→entry mapping
          const map: Record<string, number> = {};
          for (const tid of taskIds) map[tid] = newId;
          await (commands as any).timesheetSaveTaskEntries(map).catch(() => {});
          onCreated?.(newId);
          setSuccess(t("integrations.timesheet.success"));
          setTimeout(() => onClose(), 1200);
        } else {
          setError(r.error ?? "Failed to create entry");
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!editEntryId) return;
    setDeleting(true);
    setError(null);
    try {
      const r = await (commands as any).timesheetDeleteEntry(editEntryId);
      if (r.status === "ok") {
        // Remove all task→entry links pointing to this entry
        await (commands as any).timesheetRemoveEntryTasks(editEntryId).catch(() => {});
        onDeleted?.(editEntryId);
        setSuccess(t("integrations.timesheet.deleteSuccess"));
        setTimeout(() => onClose(), 1200);
      } else {
        setError(r.error ?? "Failed to delete entry");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  };

  const isConnected = !!settings?.timesheet_token;

  if (!isConnected || sessionExpired) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-background rounded-xl shadow-xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-center opacity-70">
            {sessionExpired ? t("integrations.timesheet.sessionExpired") : t("integrations.timesheet.notConnected")}
          </p>
          <p className="text-xs text-center opacity-50 mt-2">
            {t("integrations.timesheet.reconnectHint")}
          </p>
          <button onClick={onClose} className="mt-4 w-full px-4 py-2 text-xs font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/10 transition-colors">
            {t("integrations.dismiss")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-background rounded-xl shadow-xl p-6 max-w-md w-full mx-4 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4" />
            {isEditMode ? t("integrations.timesheet.editEntry") : t("integrations.timesheet.addEntry")}
            {isEditMode && isApproved && (
              <span className="px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-600 text-[10px] font-medium">
                {t("integrations.timesheet.approved")}
              </span>
            )}
          </h3>
          <div className="flex items-center gap-1">
            {!isApproved && (
              <button
                onClick={handleAiSuggest}
                disabled={aiLoadingFields.has("all") || descriptions.length === 0 || projects.length === 0}
                title={t("integrations.timesheet.aiSuggest")}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg border border-purple-400/30 text-purple-500 hover:bg-purple-500/10 disabled:opacity-40 transition-colors"
              >
                {aiLoadingFields.has("all") ? <Loader2 className="w-3 h-3 animate-spin" /> : (
                  <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1l1.5 3.5L13 6l-3.5 1.5L8 11 6.5 7.5 3 6l3.5-1.5zM3 11l.75 1.75L5.5 13.5l-1.75.75L3 16l-.75-1.75L.5 13.5l1.75-.75z" />
                  </svg>
                )}
                {t("integrations.timesheet.aiSuggest")}
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded hover:bg-mid-gray/10">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {loadingEntry ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin opacity-50" />
          </div>
        ) : success ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <Check className="w-8 h-8 text-green-500" />
            <p className="text-sm text-green-600 font-medium">{success}</p>
          </div>
        ) : (
          <>
            {/* Project + AI */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-mid-gray">{t("integrations.timesheet.project")}</label>
              <div className="flex items-center gap-1.5">
                {loadingProjects ? (
                  <div className="flex-1 flex items-center gap-2 py-1.5"><Loader2 className="w-3 h-3 animate-spin opacity-50" /></div>
                ) : (
                  <select
                    value={projectId ?? ""}
                    onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
                    disabled={isApproved}
                    className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent disabled:opacity-50"
                  >
                    <option value="">—</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({p.client_name})</option>
                    ))}
                  </select>
                )}
                {!isApproved && <AiButton onClick={() => handleAiField("project")} loading={aiLoadingFields.has("project")} title={t("integrations.timesheet.aiSuggest")} />}
              </div>
            </div>

            {/* Date selector DD / MM / YYYY */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-mid-gray">{t("integrations.timesheet.date")}</label>
              <div className="flex items-center gap-2">
                <select value={day} onChange={(e) => setDay(Number(e.target.value))} disabled={isApproved}
                  className="px-2 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent disabled:opacity-50">
                  {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{String(d).padStart(2, "0")}</option>
                  ))}
                </select>
                <span className="text-mid-gray text-sm">/</span>
                <select value={month} disabled={isApproved}
                  onChange={(e) => { setMonth(Number(e.target.value)); setDay((prev) => Math.min(prev, new Date(year, Number(e.target.value), 0).getDate())); }}
                  className="px-2 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent disabled:opacity-50">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                  ))}
                </select>
                <span className="text-mid-gray text-sm">/</span>
                <select value={year} onChange={(e) => setYear(Number(e.target.value))} disabled={isApproved}
                  className="px-2 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent disabled:opacity-50">
                  {[year - 1, year, year + 1].map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Hours + AI */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-mid-gray">{t("integrations.timesheet.hours")}</label>
              <div className="flex items-center gap-1.5">
                <div className="flex-1 relative">
                  <input
                    type="text"
                    value={hoursInput}
                    onChange={(e) => setHoursInput(e.target.value)}
                    disabled={isApproved}
                    placeholder={t("integrations.timesheet.hoursPlaceholder")}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent pr-16 disabled:opacity-50"
                  />
                  {hoursInput && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-mid-gray">
                      {formatHoursPreview(hoursInput) ?? "?"}
                    </span>
                  )}
                </div>
                {!isApproved && <AiButton onClick={() => handleAiField("hours")} loading={aiLoadingFields.has("hours")} title={t("integrations.timesheet.aiSuggest")} />}
              </div>
            </div>

            {/* Description + AI */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-mid-gray">{t("integrations.timesheet.description")}</label>
              <div className="flex items-start gap-1.5">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={isApproved}
                  placeholder={t("integrations.timesheet.descriptionPlaceholder")}
                  rows={3}
                  className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent resize-none disabled:opacity-50"
                />
                {!isApproved && <AiButton onClick={() => handleAiField("description")} loading={aiLoadingFields.has("description")} title={t("integrations.timesheet.aiSuggest")} />}
              </div>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            {/* Actions */}
            <div className="flex justify-between gap-2">
              {/* Delete button — only in edit mode for pending entries */}
              <div>
                {isEditMode && !isApproved && (
                  <button
                    onClick={handleDelete}
                    disabled={deleting || submitting}
                    className="px-4 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                  >
                    {deleting && <Loader2 className="w-3 h-3 animate-spin" />}
                    {deleting ? t("integrations.timesheet.deleting") : t("integrations.timesheet.delete")}
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 text-xs font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/10 transition-colors"
                >
                  {t("integrations.dismiss")}
                </button>
                {!isApproved && (
                  <button
                    onClick={handleSubmit}
                    disabled={submitting || deleting || !projectId || !parseHoursInput(hoursInput) || !description.trim()}
                    className="px-4 py-1.5 text-xs font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                  >
                    {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
                    {isEditMode
                      ? (submitting ? t("integrations.timesheet.updating") : t("integrations.timesheet.update"))
                      : (submitting ? t("integrations.timesheet.submitting") : t("integrations.timesheet.submit"))
                    }
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Bulk Approval Bar ───────────────────────────────────────────

function BulkApprovalBar({
  selectedCount,
  hasPreviousTasks,
  onApprove,
  onMoveToProject,
  onAddToTimesheet,
  onClear,
}: {
  selectedCount: number;
  hasPreviousTasks: boolean;
  onApprove: () => void;
  onMoveToProject: (project: string | null) => void;
  onAddToTimesheet: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="sticky bottom-0 border-t border-mid-gray/20 bg-background/95 backdrop-blur-sm px-6 py-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">
          {t("actionItems.bulk.selected", { count: selectedCount })}
        </p>
        <button onClick={onClear} className="text-[11px] text-mid-gray hover:text-red-500 transition-colors">
          {t("actionItems.bulk.clear")}
        </button>
      </div>

      <div className="flex items-center gap-2 justify-end flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-mid-gray">
          <Folder className="w-3 h-3" />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value === "") return;
              onMoveToProject(e.target.value === NO_PROJECT ? null : e.target.value);
            }}
            title={t("actionItems.project.moveHint")}
            className="px-2 py-1.5 rounded-lg border border-mid-gray/20 bg-background text-xs text-text focus:outline-none focus:border-lezat-sage/50"
          >
            <option value="">{t("actionItems.project.moveTo")}</option>
            {PROJECT_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value={NO_PROJECT}>{t("actionItems.project.none")}</option>
          </select>
        </label>
        {hasPreviousTasks && (
          <button
            onClick={onAddToTimesheet}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg border border-blue-500/30 text-blue-500 hover:bg-blue-500/10 transition-colors"
          >
            <CheckCircle2 className="w-3 h-3" />
            {t("actionItems.bulk.addToTimesheet")}
          </button>
        )}
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 transition-colors"
        >
          <Send className="w-3 h-3" />
          {t("actionItems.bulk.approve", { count: selectedCount })}
        </button>
      </div>
    </div>
  );
}

// ─── Project picker ──────────────────────────────────────────────

/** Value of the "no project" option in project selects. */
const NO_PROJECT = "__none__";

/** Chip that shows a task's project and moves it to another one. */
function ProjectPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (project: string | null) => void;
}) {
  const { t } = useTranslation();
  const options = value && !PROJECT_OPTIONS.includes(value) ? [...PROJECT_OPTIONS, value] : PROJECT_OPTIONS;
  return (
    <label
      className={`relative flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
        value ? "bg-mid-gray/8 hover:bg-mid-gray/15" : "border border-dashed border-mid-gray/40 hover:border-lezat-sage/60 hover:text-text"
      }`}
      title={t("actionItems.project.change")}
    >
      <Folder className="w-2.5 h-2.5" />
      <span>{value ?? t("actionItems.project.none")}</span>
      <ChevronDown className="w-2.5 h-2.5 opacity-60" />
      <select
        value={value ?? NO_PROJECT}
        onChange={(e) => onChange(e.target.value === NO_PROJECT ? null : e.target.value)}
        aria-label={t("actionItems.project.change")}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value={NO_PROJECT}>{t("actionItems.project.none")}</option>
      </select>
    </label>
  );
}

// ─── Memoised Action Item Row ────────────────────────────────────

/** How each sync target is shown on an approved task. */
const SYNCED_LABELS: Record<string, string> = {
  notion: "Notion",
  monday: "Monday",
  google_calendar: "Google Calendar",
  outlook_calendar: "Outlook",
};

const ActionItemRow = React.memo(function ActionItemRow({
  item,
  isSelected,
  timesheetEntryId,
  onToggleSelect,
  onUnapprove,
  onChangeProject,
  onTimesheetEdit,
  onTimesheetDelete,
}: {
  item: CloudActionItem;
  isSelected: boolean;
  timesheetEntryId?: number;
  onToggleSelect: (id: string) => void;
  onUnapprove: (item: CloudActionItem) => void;
  onChangeProject: (ids: string[], project: string | null) => void;
  onTimesheetEdit: (item: CloudActionItem, entryId: number) => void;
  onTimesheetDelete: (item: CloudActionItem, entryId: number) => void;
}) {
  const { t } = useTranslation();
  const isPending = item.status !== "completed";
  const hasTimesheetEntry = timesheetEntryId != null;

  return (
    <div
      className={`flex items-start gap-2 px-4 py-2 pl-10 transition-colors ${
        isSelected ? "bg-lezat-sage/[0.06]" : "hover:bg-mid-gray/[0.02]"
      }`}
    >
      {isPending ? (
        <button
          onClick={() => onToggleSelect(item.id)}
          className="mt-0.5 shrink-0"
          title={t("actionItems.selectTask")}
        >
          {isSelected
            ? <CheckSquare className="w-[16px] h-[16px] text-lezat-sage" />
            : <Square className="w-[16px] h-[16px] opacity-20 hover:opacity-50 transition-opacity" />
          }
        </button>
      ) : (
        <button
          onClick={() => onUnapprove(item)}
          className="mt-0.5 shrink-0"
          title={t("actionItems.unapprove")}
        >
          <CheckCircle2 className="w-[16px] h-[16px] text-green-500" />
        </button>
      )}

      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-relaxed ${
          item.status === "completed" ? "line-through opacity-50" : ""
        }`}>
          {item.title || item.description || "—"}
        </p>
        {item.title && item.description && (
          <p className={`text-xs text-mid-gray leading-relaxed line-clamp-2 ${isPending ? "" : "opacity-60"}`}>
            {item.description}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1 text-[11px] text-mid-gray flex-wrap">
          {isPending && (
            <ProjectPicker
              value={resolveProject(item)}
              onChange={(project) => onChangeProject([item.id], project)}
            />
          )}
          {item.task_type === TASK_TYPE_PREVIOUS && !hasTimesheetEntry && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-500 text-[10px] font-medium"
              title={t("actionItems.previousTaskHint")}
            >
              <CheckCircle2 className="w-2.5 h-2.5" />
              {t("actionItems.previousTask")}
            </span>
          )}
          {hasTimesheetEntry && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 text-[10px] font-medium">
              <Clock className="w-2.5 h-2.5" />
              {t("integrations.timesheet.logged")}
              <button
                onClick={(e) => { e.stopPropagation(); onTimesheetEdit(item, timesheetEntryId!); }}
                className="ml-0.5 p-0.5 rounded hover:bg-emerald-500/20 transition-colors"
                title={t("integrations.timesheet.editEntry")}
              >
                <Pencil className="w-2.5 h-2.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onTimesheetDelete(item, timesheetEntryId!); }}
                className="p-0.5 rounded hover:bg-red-500/20 text-red-500 transition-colors"
                title={t("integrations.timesheet.delete")}
              >
                <Trash2 className="w-2.5 h-2.5" />
              </button>
            </span>
          )}
          {item.assignee && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-mid-gray/8">
              <User className="w-2.5 h-2.5" />
              {item.assignee}
            </span>
          )}
          {item.due_date && (
            <span className="flex items-center gap-1">
              <CalendarDays className="w-2.5 h-2.5" />
              {formatDate(item.due_date)}
            </span>
          )}
          {isPending && item.notion_database_title && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-mid-gray/8"
              title={item.notion_database_reason ?? undefined}
            >
              <Database className="w-2.5 h-2.5" />
              {item.notion_database_title}
            </span>
          )}
          {item.synced_to.map((s: string) => (
            <span
              key={s}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-lezat-sage/15 text-lezat-sage text-[10px] font-medium"
              title={t("actionItems.syncedTo", { name: SYNCED_LABELS[s] ?? s })}
            >
              <Check className="w-2.5 h-2.5" />
              {SYNCED_LABELS[s] ?? s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
});

// ─── Selection checkbox for a set of tasks ──────────────────────

type SelectionState = "none" | "some" | "all";

/** Selection of the not-yet-approved tasks in `items`. */
function selectionOf(items: CloudActionItem[], selected: Set<string>): SelectionState {
  const pending = items.filter((i) => i.status !== "completed");
  if (pending.length === 0) return "none";
  const count = pending.filter((i) => selected.has(i.id)).length;
  if (count === 0) return "none";
  return count === pending.length ? "all" : "some";
}

function SelectAllBox({ state, className }: { state: SelectionState; className: string }) {
  if (state === "all") return <CheckSquare className={`${className} text-lezat-sage`} />;
  if (state === "some") return <MinusSquare className={`${className} text-lezat-sage`} />;
  return <Square className={className} />;
}

// ─── Memoised Meeting Group ─────────────────────────────────────

const MeetingGroupCard = React.memo(function MeetingGroupCard({
  group,
  isCollapsed,
  selected,
  taskEntryMap,
  onToggleCollapse,
  onToggleSelectAll,
  onToggleSelect,
  onUnapprove,
  onChangeProject,
  onTimesheetEdit,
  onTimesheetDelete,
  t,
}: {
  group: MeetingGroup;
  isCollapsed: boolean;
  selected: Set<string>;
  taskEntryMap: Record<string, number>;
  onToggleCollapse: (meetingId: string) => void;
  /** Select (or clear, if all are selected) the pending tasks among `items`. */
  onToggleSelectAll: (items: CloudActionItem[]) => void;
  onToggleSelect: (id: string) => void;
  onUnapprove: (item: CloudActionItem) => void;
  onChangeProject: (ids: string[], project: string | null) => void;
  onTimesheetEdit: (item: CloudActionItem, entryId: number) => void;
  onTimesheetDelete: (item: CloudActionItem, entryId: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const progress = group.total > 0 ? Math.round((group.completed / group.total) * 100) : 0;

  // Inside the meeting: one block per project, "no project" last; pending tasks first.
  const projectGroups = useMemo(() => {
    const pendingFirst = [
      // To do first, then tasks already done (daily standup), then approved ones.
      ...group.items.filter((i) => i.status !== "completed" && i.task_type !== TASK_TYPE_PREVIOUS),
      ...group.items.filter((i) => i.status !== "completed" && i.task_type === TASK_TYPE_PREVIOUS),
      ...group.items.filter((i) => i.status === "completed"),
    ];
    return groupByProject(pendingFirst);
  }, [group.items]);
  // A lone "no project" block needs no heading.
  const showProjectHeaders = !(projectGroups.length === 1 && projectGroups[0].project === null);

  const renderRow = (item: CloudActionItem) => (
    <ActionItemRow
      key={item.id}
      item={item}
      isSelected={selected.has(item.id)}
      timesheetEntryId={taskEntryMap[item.id]}
      onToggleSelect={onToggleSelect}
      onUnapprove={onUnapprove}
      onChangeProject={onChangeProject}
      onTimesheetEdit={onTimesheetEdit}
      onTimesheetDelete={onTimesheetDelete}
    />
  );

  return (
    <div className="border-b border-mid-gray/10">
      {/* Meeting header */}
      <div className="flex items-center gap-1 px-4 py-3 hover:bg-mid-gray/[0.03] transition-colors">
        <button
          onClick={() => onToggleSelectAll(group.items)}
          className="p-1 shrink-0 opacity-40 hover:opacity-100 transition-opacity"
          title={t("actionItems.bulk.selectGroup")}
        >
          <SelectAllBox state={selectionOf(group.items, selected)} className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => onToggleCollapse(group.meeting_id)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {isCollapsed
            ? <ChevronRight className="w-4 h-4 text-mid-gray shrink-0" />
            : <ChevronDown className="w-4 h-4 text-mid-gray shrink-0" />
          }
          <Video className="w-4 h-4 text-mid-gray shrink-0" />
          <p className="flex-1 min-w-0 text-sm font-medium truncate">{group.meeting_title}</p>
        </button>

        <div
          className="flex items-center gap-2 shrink-0"
          title={t("actionItems.approvedCount", { done: group.completed, total: group.total })}
        >
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
            progress === 100 ? "bg-green-500/15 text-green-600" : "bg-mid-gray/10 text-mid-gray"
          }`}>
            {group.completed}/{group.total}
          </span>
          <div className="w-16 h-1.5 rounded-full bg-mid-gray/10 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${progress === 100 ? "bg-green-500" : "bg-lezat-sage"}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Items, grouped by project */}
      {!isCollapsed && (
        <div className="pb-2 flex flex-col gap-1">
          {projectGroups.map((pg) => {
            if (!showProjectHeaders) return pg.items.map(renderRow);
            const state = selectionOf(pg.items, selected);
            const hasPending = pg.items.some((i) => i.status !== "completed");
            return (
              <div key={pg.project ?? "__none__"}>
                <div className="flex items-center gap-1.5 pl-[38px] pr-4 pt-2 pb-1">
                  {hasPending ? (
                    <button
                      onClick={() => onToggleSelectAll(pg.items)}
                      className="p-0.5 shrink-0 opacity-40 hover:opacity-100 transition-opacity"
                      title={t("actionItems.projects.selectAll")}
                    >
                      <SelectAllBox state={state} className="w-3 h-3" />
                    </button>
                  ) : (
                    <Folder className="w-3 h-3 m-0.5 text-mid-gray shrink-0" />
                  )}
                  <span className={`text-xs font-semibold ${
                    pg.project ? "text-text/80" : "text-mid-gray"
                  }`}>
                    {pg.project ?? t("actionItems.projects.none")}
                  </span>
                  <span className="text-[10px] text-mid-gray">{pg.items.length}</span>
                </div>
                {pg.items.map(renderRow)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

const PAGE_SIZE = 4;

// ─── Main Page ───────────────────────────────────────────────────

/** Items approved or synced from the web count as approved here, so they can't be
 *  approved (and sent to Notion) a second time; rejected ones are not shown. */
function normalizeStatuses(items: CloudActionItem[]): CloudActionItem[] {
  return items
    .filter((i) => i.status !== "rejected")
    .map((i) =>
      i.status === "approved" || i.status === "synced"
        ? { ...i, status: "completed" }
        : i,
    );
}

export const ActionItemsPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [items, setItems] = useState<CloudActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Approval failures: shown as a banner so the list (and the selection) stays usable.
  const [approveError, setApproveError] = useState<{ failed: number; detail: string } | null>(null);
  const [projectError, setProjectError] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [, startTransition] = useTransition();
  const [taskEntryMap, setTaskEntryMap] = useState<Record<string, number>>({});
  const [timesheetDialog, setTimesheetDialog] = useState<{
    descriptions: string[];
    taskIds: string[];
    editEntryId?: number;
  } | null>(null);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);

  // Pre-loaded config (fetched once on mount, shared with all panels)
  const [preloaded, setPreloaded] = useState<PreloadedConfig>({
    notionDbs: [], mondayBoards: [],
    notionStatuses: {}, mondayStatuses: {}, notionPeople: [],
  });

  const isConfigured = settings?.cloud_sync_url && settings?.cloud_sync_api_key;

  // Phase 1: Load items + integrations (fast, shows UI immediately)
  const fetchItems = useCallback(async () => {
    if (!isConfigured) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [itemsRes, intRes] = await Promise.all([
        (commands as any).cloudGetActionItems(),
        (commands as any).cloudGetIntegrationsStatus(),
      ]);
      if (itemsRes.status === "ok") setItems(normalizeStatuses(itemsRes.data.items));
      else setError(itemsRes.error);
      if (intRes.status === "ok") setIntegrations(intRes.data.integrations);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [isConfigured]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Load task→entry mapping from settings
  useEffect(() => {
    (commands as any).timesheetGetTaskEntries().then((r: any) => {
      if (r.status === "ok") setTaskEntryMap(r.data);
    }).catch(() => {});
  }, []);

  // Phase 2: Pre-load config in the background (doesn't block UI)
  useEffect(() => {
    if (integrations.length === 0) return;
    const cfg: PreloadedConfig = { notionDbs: [], mondayBoards: [], notionStatuses: {}, mondayStatuses: {}, notionPeople: [] };

    const notion = integrations.find((i) => i.provider === "notion" && i.connected);

    const promises: Promise<void>[] = [];
    if (notion) {
      promises.push(
        commands.cloudGetNotionUsers().then((r) => {
          if (r.status === "ok") cfg.notionPeople = r.data;
        }).catch(() => {}),
      );
      promises.push(
        (commands as any).cloudGetNotionDatabases().then(async (r: any) => {
          if (r.status === "ok") {
            cfg.notionDbs = r.data;
            // Pre-load statuses for ALL databases so they're ready when the modal opens
            const statusPromises = (r.data as SelectOption[]).map((db) =>
              (commands as any).cloudGetNotionStatusOptions(db.id).then((sr: any) => {
                if (sr.status === "ok") {
                  cfg.notionStatuses[db.id] = sr.data.map((o: any) => ({ id: o.name, name: o.name }));
                }
              }).catch(() => {}),
            );
            await Promise.all(statusPromises);
          }
        }).catch(() => {}),
      );
    }
    Promise.all(promises).then(() => setPreloaded(cfg));
  }, [integrations]);

  // Group items by meeting
  const groups: MeetingGroup[] = useMemo(() => {
    const map = new Map<string, MeetingGroup>();
    for (const item of items) {
      const key = item.meeting_id ?? "unknown";
      if (!map.has(key)) {
        map.set(key, {
          meeting_id: key,
          meeting_title: item.meeting_name ?? item.meeting_title ?? t("actionItems.untitledMeeting"),
          items: [], completed: 0, total: 0,
        });
      }
      const group = map.get(key)!;
      group.items.push(item);
      group.total++;
      if (item.status === "completed") group.completed++;
    }
    return Array.from(map.values()).sort((a, b) => {
      const dateA = a.items[0]?.created_at ?? "";
      const dateB = b.items[0]?.created_at ?? "";
      return dateB.localeCompare(dateA);
    });
  }, [items, t]);

  // Reset visible count when groups change (new fetch)
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [groups.length]);

  const visibleGroups = useMemo(() => groups.slice(0, visibleCount), [groups, visibleCount]);
  const hasMore = visibleCount < groups.length;
  const remaining = groups.length - visibleCount;

  const handleLoadMore = useCallback(() => {
    startTransition(() => {
      setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, groups.length));
    });
  }, [groups.length]);

  // Auto-collapse: only the most recent meeting is open
  useEffect(() => {
    if (groups.length > 0 && collapsed === null) {
      setCollapsed(new Set(groups.slice(1).map((g) => g.meeting_id)));
    }
  }, [groups, collapsed]);

  // ── Selection helpers ──

  const pendingItems = useMemo(() => items.filter((i) => i.status !== "completed"), [items]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleSelectAll = useCallback((groupItems: CloudActionItem[]) => {
    const pending = groupItems.filter((i) => i.status !== "completed");
    setSelected((prev) => {
      const allSelected = pending.every((i) => prev.has(i.id));
      const n = new Set(prev);
      for (const i of pending) {
        if (allSelected) n.delete(i.id); else n.add(i.id);
      }
      return n;
    });
  }, []);

  // ── Approve helpers ──

  const handleOpenReviewModal = () => {
    setReviewModalOpen(true);
  };

  const handleReviewConfirm = async (
    edits: Record<string, ItemEdits>,
    integrationSettings: Record<string, string>,
    syncTargets: string[],
  ) => {
    if (Object.keys(integrationSettings).length > 0) {
      try {
        await (commands as any).cloudUpdateIntegrationSettings(integrationSettings);
      } catch (e) {
        console.warn("cloudUpdateIntegrationSettings failed:", e);
      }
    }
    const ids = Array.from(selected);
    const results = await Promise.allSettled(
      ids.map((id) => {
        const itemEdits = edits[id] ?? {};
        const original = items.find((i) => i.id === id);
        const dueDate = itemEdits.due_date ?? original?.due_date;
        const alreadyDone = (itemEdits.task_type ?? original?.task_type) === TASK_TYPE_PREVIOUS;
        // Include sync_targets so the backend knows which integrations to push to;
        // a task without a date, or already done, can't become a calendar event.
        const targetsForItem =
          dueDate && !alreadyDone ? syncTargets : syncTargets.filter((t) => !CALENDAR_TARGETS.includes(t));
        const payload = { ...itemEdits, sync_targets: targetsForItem };
        return (commands as any).cloudUpdateActionItem(id, "completed", JSON.stringify(payload));
      }),
    );
    const succeeded = new Set<string>();
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && (r.value as any).status === "ok") {
        succeeded.add(ids[i]);
      } else {
        const errMsg = r.status === "rejected" ? String(r.reason) : (r.value as any).error;
        if (errMsg) errors.push(errMsg);
      }
    });
    if (errors.length > 0) {
      console.warn("Some action items failed to approve:", errors);
    }
    const failedCount = ids.length - succeeded.size;
    setApproveError(
      failedCount > 0 ? { failed: failedCount, detail: errors[0] ?? "" } : null,
    );
    // Update local items with edits + status change
    setItems((prev) => prev.map((i) => {
      if (!succeeded.has(i.id)) return i;
      const itemEdits = edits[i.id];
      return {
        ...i,
        status: "completed",
        synced_to: Array.from(new Set([...(i.synced_to ?? []), ...syncTargets.filter((t) => t === "notion")])),
        ...(itemEdits?.description != null ? { description: itemEdits.description } : {}),
        ...(itemEdits?.assignee != null ? { assignee: itemEdits.assignee } : {}),
        ...(itemEdits?.assignee_notion_user_id != null
          ? { assignee_notion_user_id: itemEdits.assignee_notion_user_id }
          : {}),
        ...(itemEdits?.due_date != null ? { due_date: itemEdits.due_date } : {}),
        ...(itemEdits?.task_type != null ? { task_type: itemEdits.task_type } : {}),
      };
    }));
    // Tasks that failed stay selected so the user can retry them.
    setSelected(new Set(ids.filter((id) => !succeeded.has(id))));
    setReviewModalOpen(false);
  };

  // Move tasks to a project (or to "no project"). Shown at once; saved in the
  // backend, and undone if saving fails.
  const handleChangeProject = useCallback(
    async (ids: string[], project: string | null) => {
      const targets = items.filter((i) => ids.includes(i.id) && i.status !== "completed");
      if (targets.length === 0) return;
      const before = new Map(targets.map((i) => [i.id, i.project ?? null]));
      setItems((prev) => prev.map((i) => (before.has(i.id) ? { ...i, project } : i)));
      const results = await Promise.allSettled(
        targets.map((i) =>
          (commands as any).cloudUpdateActionItem(i.id, i.status, JSON.stringify({ project: project ?? "" })),
        ),
      );
      const failed = targets.filter(
        (_, idx) => results[idx].status !== "fulfilled" || (results[idx] as PromiseFulfilledResult<any>).value?.status !== "ok",
      );
      if (failed.length > 0) {
        const failedIds = new Set(failed.map((i) => i.id));
        setItems((prev) => prev.map((i) => (failedIds.has(i.id) ? { ...i, project: before.get(i.id) ?? null } : i)));
        setProjectError(failed.length);
      }
    },
    [items],
  );

  const handleUnapprove = async (item: CloudActionItem) => {
    try {
      const r = await (commands as any).cloudUpdateActionItem(item.id, "pending");
      if (r.status === "ok") setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "pending" } : i));
    } catch { /* */ }
  };

  const toggleCollapse = (meetingId: string) => {
    setCollapsed((prev) => {
      const next = new Set<string>(prev ?? new Set());
      if (next.has(meetingId)) next.delete(meetingId); else next.add(meetingId);
      return next;
    });
  };

  // ── Timesheet helpers ──

  const openTimesheetCreate = () => {
    const selectedItems = items.filter((i) => selected.has(i.id));
    setTimesheetDialog({
      descriptions: selectedItems.map((i) => i.description ?? "").filter(Boolean),
      taskIds: selectedItems.map((i) => i.id),
    });
  };

  const openTimesheetEdit = (_item: CloudActionItem, entryId: number) => {
    // Find all task IDs pointing to this entry
    const taskIds = Object.entries(taskEntryMap)
      .filter(([, eid]) => eid === entryId)
      .map(([tid]) => tid);
    const relatedItems = items.filter((i) => taskIds.includes(i.id));
    setTimesheetDialog({
      descriptions: relatedItems.map((i) => i.description ?? "").filter(Boolean),
      taskIds,
      editEntryId: entryId,
    });
  };

  const handleTimesheetCreated = (entryId: number) => {
    if (!timesheetDialog) return;
    const newMap = { ...taskEntryMap };
    for (const tid of timesheetDialog.taskIds) newMap[tid] = entryId;
    setTaskEntryMap(newMap);
  };

  const handleTimesheetDeleted = (entryId: number) => {
    const newMap = { ...taskEntryMap };
    for (const [tid, eid] of Object.entries(newMap)) {
      if (eid === entryId) delete newMap[tid];
    }
    setTaskEntryMap(newMap);
  };

  const handleInlineTimesheetDelete = async (_item: CloudActionItem, entryId: number) => {
    try {
      const r = await (commands as any).timesheetDeleteEntry(entryId);
      if (r.status === "ok") {
        await (commands as any).timesheetRemoveEntryTasks(entryId).catch(() => {});
        handleTimesheetDeleted(entryId);
      }
    } catch { /* */ }
  };

  // ── Render ──

  if (!isConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
        <CloudOff className="w-12 h-12 opacity-40" />
        <p className="text-lg font-medium opacity-70">{t("actionItems.notConfigured")}</p>
        <p className="text-sm opacity-50">{t("actionItems.configureHint")}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin opacity-50" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
        <AlertCircle className="w-12 h-12 text-red-500/60" />
        <p className="text-sm text-red-500">{error}</p>
        <button onClick={fetchItems} className="px-4 py-2 text-sm rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 transition-colors">
          {t("actionItems.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-mid-gray/20">
        <div>
          <h2 className="text-lg font-semibold">{t("actionItems.title")}</h2>
          {items.length > 0 && (
            <p className="text-xs text-mid-gray">
              {t("actionItems.summary", { total: items.length, meetings: groups.length })}
            </p>
          )}
        </div>
        <button onClick={fetchItems} className="p-2 rounded-lg hover:bg-mid-gray/10 transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {approveError && (
        <div className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium">
              {t("actionItems.approval.failed", { count: approveError.failed })}
            </p>
            {approveError.detail && (
              <p className="opacity-80 break-words line-clamp-2">{approveError.detail}</p>
            )}
          </div>
          <button
            onClick={() => setApproveError(null)}
            className="p-0.5 rounded hover:bg-red-500/20"
            title={t("actionItems.approval.dismissError")}
            aria-label={t("actionItems.approval.dismissError")}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {projectError && (
        <div className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <p className="flex-1">{t("actionItems.project.saveFailed", { count: projectError })}</p>
          <button onClick={() => setProjectError(null)} className="p-0.5 rounded hover:bg-amber-500/20">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-8">
          <Video className="w-10 h-10 opacity-20" />
          <p className="text-sm opacity-50">{t("actionItems.empty")}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {visibleGroups.map((group) => (
            <MeetingGroupCard
              key={group.meeting_id}
              group={group}
              isCollapsed={collapsed?.has(group.meeting_id) ?? false}
              selected={selected}
              taskEntryMap={taskEntryMap}
              onToggleCollapse={toggleCollapse}
              onToggleSelectAll={toggleSelectAll}
              onToggleSelect={toggleSelect}
              onUnapprove={handleUnapprove}
              onChangeProject={handleChangeProject}
              onTimesheetEdit={openTimesheetEdit}
              onTimesheetDelete={handleInlineTimesheetDelete}
              t={t}
            />
          ))}

          {hasMore && (
            <button
              onClick={handleLoadMore}
              className="flex items-center justify-center gap-2 w-full py-3 text-sm text-mid-gray hover:text-foreground hover:bg-mid-gray/[0.05] transition-colors"
            >
              <ChevronsDown className="w-4 h-4" />
              {t("actionItems.loadMore", { remaining: Math.max(remaining, 0) })}
            </button>
          )}
        </div>
      )}

      {/* Bulk approval bar — sticky bottom */}
      {selected.size > 0 && (
        <BulkApprovalBar
          selectedCount={selected.size}
          hasPreviousTasks={items.some((i) => selected.has(i.id) && i.task_type === "completed_previous")}
          onApprove={handleOpenReviewModal}
          onMoveToProject={(project) => handleChangeProject(Array.from(selected), project)}
          onAddToTimesheet={openTimesheetCreate}
          onClear={() => setSelected(new Set())}
        />
      )}

      {/* Approval review modal */}
      {reviewModalOpen && selected.size > 0 && (
        <ApprovalReviewModal
          items={items.filter((i) => selected.has(i.id))}
          integrations={integrations}
          config={preloaded}
          onConfirm={handleReviewConfirm}
          onClose={() => setReviewModalOpen(false)}
        />
      )}

      {timesheetDialog && (
        <TimesheetDialog
          descriptions={timesheetDialog.descriptions}
          taskIds={timesheetDialog.taskIds}
          editEntryId={timesheetDialog.editEntryId}
          onClose={() => setTimesheetDialog(null)}
          onCreated={handleTimesheetCreated}
          onDeleted={handleTimesheetDeleted}
          onUpdated={() => {}}
        />
      )}
    </div>
  );
};

export default ActionItemsPage;
