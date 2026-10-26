import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  Camera,
  CameraOff,
  Check,
  Copy,
  FolderKanban,
  Gavel,
  Languages,
  ListChecks,
  Loader2,
  Lock,
  LogOut,
  Pause,
  PenLine,
  Play,
  Send,
  SlidersHorizontal,
  Sparkles,
  SquareCheckBig,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { commands } from "@/bindings";
import type { BotLive, BotNote } from "@/bindings";

/// While NoteZat is in a meeting, the app can do privately what the meeting
/// chat commands do: notes (never said in the chat), questions (answered only
/// here) and controls (announced in the chat, they affect everyone).

const POLL_MS = 8000;

type Tab = "note" | "ask" | "controls";
type NoteKind = "task" | "decision" | "mark" | "project";
type AskKind = "live_summary" | "live_tasks" | "live_question";

const NOTE_KINDS: {
  kind: NoteKind;
  icon: typeof SquareCheckBig;
  /// Tailwind classes for the chip when selected, and for the note's icon.
  tone: string;
}[] = [
  {
    kind: "task",
    icon: SquareCheckBig,
    tone: "bg-green-500/15 text-green-600 border-green-500/40",
  },
  {
    kind: "decision",
    icon: Gavel,
    tone: "bg-blue-500/15 text-blue-500 border-blue-500/40",
  },
  {
    kind: "mark",
    icon: Bookmark,
    tone: "bg-amber-500/15 text-amber-600 border-amber-500/40",
  },
  {
    kind: "project",
    icon: FolderKanban,
    tone: "bg-purple-500/15 text-purple-500 border-purple-500/40",
  },
];

/// Caption languages the bot knows (backend: meeting_bot_commands).
const LANGUAGES = [
  "español",
  "inglés",
  "portugués",
  "francés",
  "alemán",
  "italiano",
] as const;

function noteMeta(kind: string) {
  return NOTE_KINDS.find((n) => n.kind === kind) ?? NOTE_KINDS[0];
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function LiveMeetingPanel({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const [live, setLive] = useState<BotLive | null>(null);
  const [tab, setTab] = useState<Tab>("note");

  const refresh = useCallback(async () => {
    try {
      const res = await commands.cloudGetBotLive(botId);
      if (res.status === "ok") setLive(res.data);
    } catch {
      // Offline: keep what is shown, the next poll tries again.
    }
  }, [botId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!live || !live.in_meeting) return null;

  const tabs: { id: Tab; icon: typeof PenLine }[] = [
    { id: "note", icon: PenLine },
    { id: "ask", icon: Sparkles },
    { id: "controls", icon: SlidersHorizontal },
  ];

  return (
    <div className="rounded-xl border border-lezat-sage/40 bg-lezat-sage/5 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 border-b border-lezat-sage/20">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {!live.paused && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 animate-ping" />
          )}
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
              live.paused ? "bg-amber-500" : "bg-red-500"
            }`}
          />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase text-mid-gray">
            {t("meetingBot.live.badge")}
          </div>
          <div className="text-sm font-semibold truncate">
            {live.title || t("meetingBot.live.untitled")}
          </div>
          <div className="text-xs text-mid-gray">
            {live.paused
              ? t("meetingBot.live.paused")
              : t("meetingBot.live.recording")}
            {live.language &&
              ` · ${t("meetingBot.live.languageIs", { language: live.language })}`}
          </div>
        </div>
        <span
          className="flex items-center gap-1 text-[11px] text-mid-gray shrink-0"
          title={t("meetingBot.live.privateHint")}
        >
          <Lock className="w-3 h-3" />
          {t("meetingBot.live.private")}
        </span>
      </div>

      <div className="flex px-2 pt-2 gap-1" role="tablist">
        {tabs.map(({ id, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm transition ${
              tab === id
                ? "bg-background font-medium shadow-sm"
                : "text-mid-gray hover:bg-mid-gray/10"
            }`}
          >
            <Icon className="w-4 h-4" />
            {t(`meetingBot.live.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === "note" && (
          <NoteTab botId={botId} notes={live.notes ?? []} onSaved={setLive} />
        )}
        {tab === "ask" && <AskTab botId={botId} />}
        {tab === "controls" && <ControlsTab live={live} onChanged={setLive} />}
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 text-sm rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 p-3">
      <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function NoteTab({
  botId,
  notes,
  onSaved,
}: {
  botId: string;
  notes: BotNote[];
  onSaved: (live: BotLive) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<NoteKind>("task");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedKind, setSavedKind] = useState<NoteKind | null>(null);

  // A marked moment needs no text; the others do.
  const canSave = !saving && (kind === "mark" || text.trim().length > 0);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await commands.cloudAddBotNote(botId, kind, text.trim());
      if (res.status === "ok") {
        onSaved(res.data);
        setText("");
        setSavedKind(kind);
        setTimeout(() => setSavedKind(null), 2500);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        {NOTE_KINDS.map(({ kind: k, icon: Icon, tone }) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs transition ${
              kind === k
                ? `${tone} font-medium`
                : "border-mid-gray/20 text-mid-gray hover:bg-mid-gray/10"
            }`}
          >
            <Icon className="w-5 h-5" />
            {t(`meetingBot.live.kinds.${k}`)}
          </button>
        ))}
      </div>
      <p className="text-xs text-mid-gray">
        {t(`meetingBot.live.kindHints.${kind}`)}
      </p>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder={t(`meetingBot.live.placeholders.${kind}`)}
          className="flex-1 px-3 py-2 rounded-lg border border-mid-gray/30 bg-background text-sm"
          disabled={saving}
        />
        <button
          onClick={() => void save()}
          disabled={!canSave}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-logo-primary text-background text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : savedKind ? (
            <Check className="w-4 h-4" />
          ) : (
            <PenLine className="w-4 h-4" />
          )}
          {savedKind ? t("meetingBot.live.saved") : t("meetingBot.live.save")}
        </button>
      </div>
      {error && <ErrorBox message={error} />}

      <div className="flex flex-col gap-2 pt-3 border-t border-mid-gray/15">
        <div className="text-xs font-semibold text-mid-gray">
          {t("meetingBot.live.notesTitle", { count: notes.length })}
        </div>
        {notes.length === 0 ? (
          <p className="text-xs text-mid-gray">
            {t("meetingBot.live.notesEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2 max-h-56 overflow-y-auto">
            {[...notes].reverse().map((note, i) => {
              const { icon: Icon, tone } = noteMeta(note.kind);
              return (
                <li
                  key={`${note.at}-${i}`}
                  className="flex items-start gap-2.5"
                >
                  <span
                    className={`mt-0.5 rounded-md border p-1 shrink-0 ${tone}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm leading-snug break-words">
                      {note.text || t(`meetingBot.live.kinds.${note.kind}`)}
                    </div>
                    <div className="text-[11px] text-mid-gray">
                      {[
                        t(`meetingBot.live.kinds.${note.kind}`),
                        note.author,
                        formatTime(note.at),
                        t(
                          note.source === "app"
                            ? "meetingBot.live.fromApp"
                            : "meetingBot.live.fromChat",
                        ),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function AskTab({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<AskKind | null>(null);
  const [answer, setAnswer] = useState<{ asked: string; text: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const ask = async (kind: AskKind) => {
    if (asking) return;
    if (kind === "live_question" && !question.trim()) return;
    setAsking(kind);
    setError(null);
    const asked =
      kind === "live_question"
        ? question.trim()
        : t(`meetingBot.live.ask.${kind}`);
    try {
      const res = await commands.cloudAskBot(botId, kind, question.trim());
      if (res.status === "ok") {
        setAnswer({ asked, text: res.data.answer });
        if (kind === "live_question") setQuestion("");
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setAsking(null);
    }
  };

  const copy = async () => {
    if (!answer) return;
    await navigator.clipboard.writeText(answer.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["live_summary", Sparkles],
            ["live_tasks", ListChecks],
          ] as const
        ).map(([kind, Icon]) => (
          <button
            key={kind}
            onClick={() => void ask(kind)}
            disabled={asking !== null}
            className="flex items-center justify-center gap-2 rounded-lg border border-mid-gray/25 px-3 py-3 text-sm font-medium hover:bg-mid-gray/10 disabled:opacity-50 transition"
          >
            {asking === kind ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Icon className="w-4 h-4 text-lezat-sage" />
            )}
            {t(`meetingBot.live.ask.${kind}`)}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask("live_question")}
          placeholder={t("meetingBot.live.ask.placeholder")}
          className="flex-1 px-3 py-2 rounded-lg border border-mid-gray/30 bg-background text-sm"
          disabled={asking !== null}
        />
        <button
          onClick={() => void ask("live_question")}
          disabled={asking !== null || !question.trim()}
          className="flex items-center px-3 py-2 rounded-lg bg-logo-primary text-background hover:opacity-90 disabled:opacity-50 transition"
          aria-label={t("meetingBot.live.ask.send")}
        >
          {asking === "live_question" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>

      {asking && (
        <div className="rounded-lg border border-mid-gray/20 p-3 flex flex-col gap-2">
          <div className="text-xs text-mid-gray flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t("meetingBot.live.ask.thinking")}
          </div>
          <div className="h-3 rounded bg-mid-gray/15 animate-pulse w-11/12" />
          <div className="h-3 rounded bg-mid-gray/15 animate-pulse w-9/12" />
          <div className="h-3 rounded bg-mid-gray/15 animate-pulse w-10/12" />
        </div>
      )}
      {!asking && error && <ErrorBox message={error} />}
      {!asking && answer && (
        <div className="rounded-lg border border-lezat-sage/30 bg-background p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-lezat-sage shrink-0" />
            <div className="flex-1 text-xs font-semibold text-mid-gray truncate">
              {answer.asked}
            </div>
            <button
              onClick={() => void copy()}
              className="flex items-center gap-1 text-xs text-mid-gray hover:text-text"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {t(
                copied
                  ? "meetingBot.live.ask.copied"
                  : "meetingBot.live.ask.copy",
              )}
            </button>
          </div>
          <div className="text-sm leading-relaxed whitespace-pre-line">
            {answer.text}
          </div>
          <div className="text-[11px] text-mid-gray flex items-center gap-1">
            <Lock className="w-3 h-3" />
            {t("meetingBot.live.ask.onlyYou")}
          </div>
        </div>
      )}
      {!asking && !answer && !error && (
        <p className="text-xs text-mid-gray">{t("meetingBot.live.ask.hint")}</p>
      )}
    </div>
  );
}

function ControlsTab({
  live,
  onChanged,
}: {
  live: BotLive;
  onChanged: (live: BotLive) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (action: string, text = "") => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const res = await commands.cloudControlBot(live.bot_id, action, text);
      if (res.status === "ok") onChanged(res.data);
      else setError(res.error);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  const spinner = <Loader2 className="w-4 h-4 animate-spin" />;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => void run(live.paused ? "resume" : "pause")}
          disabled={busy !== null}
          className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-3 text-left transition disabled:opacity-50 ${
            live.paused
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-mid-gray/25 hover:bg-mid-gray/10"
          }`}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            {busy === "pause" || busy === "resume" ? (
              spinner
            ) : live.paused ? (
              <Play className="w-4 h-4" />
            ) : (
              <Pause className="w-4 h-4" />
            )}
            {t(
              live.paused ? "meetingBot.live.resume" : "meetingBot.live.pause",
            )}
          </span>
          <span className="text-[11px] text-mid-gray">
            {t(
              live.paused
                ? "meetingBot.live.resumeHint"
                : "meetingBot.live.pauseHint",
            )}
          </span>
        </button>

        <button
          onClick={() =>
            void run(live.captures_on ? "capture_off" : "capture_on")
          }
          disabled={busy !== null || !live.captures_available}
          className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-3 text-left transition disabled:opacity-50 ${
            live.captures_on
              ? "border-lezat-sage/50 bg-lezat-sage/10"
              : "border-mid-gray/25 hover:bg-mid-gray/10"
          }`}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            {busy?.startsWith("capture") ? (
              spinner
            ) : live.captures_on ? (
              <Camera className="w-4 h-4" />
            ) : (
              <CameraOff className="w-4 h-4" />
            )}
            {t(
              live.captures_on
                ? "meetingBot.live.capturesOn"
                : "meetingBot.live.capturesOff",
            )}
          </span>
          <span className="text-[11px] text-mid-gray">
            {t(
              live.captures_available
                ? "meetingBot.live.capturesHint"
                : "meetingBot.live.capturesUnavailable",
            )}
          </span>
        </button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Languages className="w-4 h-4 text-mid-gray" />
        <span className="flex-1">{t("meetingBot.live.language")}</span>
        <select
          value={live.language ?? "español"}
          onChange={(e) => void run("language", e.target.value)}
          disabled={busy !== null}
          className="px-2 py-1.5 rounded-lg border border-mid-gray/30 bg-background text-sm capitalize"
        >
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
      </label>

      <p className="text-[11px] text-mid-gray">
        {t("meetingBot.live.announcedHint")}
      </p>

      <div className="flex flex-col gap-2 pt-3 border-t border-mid-gray/15">
        <button
          onClick={() => void run("leave")}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-lg border border-mid-gray/25 px-3 py-2 text-sm hover:bg-mid-gray/10 disabled:opacity-50 transition"
        >
          {busy === "leave" ? spinner : <LogOut className="w-4 h-4" />}
          <span className="flex-1 text-left">{t("meetingBot.live.leave")}</span>
          <span className="text-[11px] text-mid-gray">
            {t("meetingBot.live.leaveHint")}
          </span>
        </button>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={busy !== null}
            className="flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-50 transition"
          >
            <Trash2 className="w-4 h-4" />
            <span className="flex-1 text-left">
              {t("meetingBot.live.delete")}
            </span>
            <span className="text-[11px] opacity-80">
              {t("meetingBot.live.deleteHint")}
            </span>
          </button>
        ) : (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 flex flex-col gap-2">
            <p className="text-sm text-red-600 dark:text-red-400">
              {t("meetingBot.live.deleteConfirm")}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-sm hover:bg-mid-gray/10"
              >
                {t("meetingBot.live.cancel")}
              </button>
              <button
                onClick={() => void run("delete")}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {busy === "delete" ? spinner : <Trash2 className="w-4 h-4" />}
                {t("meetingBot.live.deleteYes")}
              </button>
            </div>
          </div>
        )}
      </div>
      {error && <ErrorBox message={error} />}
    </div>
  );
}
