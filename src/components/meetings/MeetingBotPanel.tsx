import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  CalendarDays,
  Loader2,
  LogOut,
  RotateCcw,
  Send,
  ListChecks,
} from "lucide-react";
import { commands } from "@/bindings";
import type { MeetingBot, MeetingBotSettings } from "@/bindings";
import { formatDayMonthYearTime } from "@/utils/dayMonthYear";
import { LiveMeetingPanel } from "./LiveMeetingPanel";

/// Bot states after which it is out of the meeting for good.
const GONE_STATES = new Set(["ended", "fatal_error", "data_deleted"]);
/// Statuses after which nothing else will happen to the bot.
const FINAL_STATUSES = new Set([
  "ingested",
  "no_transcript",
  "discarded",
  "failed",
]);
const POLL_MS = 8000;
/// With auto-join on, bots appear without the user doing anything.
const AUTO_JOIN_POLL_MS = 30000;
const AUTO_JOIN_MODES = ["off", "all", "organized"] as const;
const SHOWN_UPCOMING = 4;
const SHOWN_BOTS = 5;

function isFinished(bot: MeetingBot): boolean {
  return (
    FINAL_STATUSES.has(bot.status) &&
    (GONE_STATES.has(bot.state) || bot.status === "failed")
  );
}

function inMeeting(bot: MeetingBot): boolean {
  return bot.state.startsWith("joined");
}

/// Processed without tasks (Gemini failed, or nothing came out): the tasks can
/// be extracted again. A bot that never got a transcript has nothing to retry.
function canRetry(bot: MeetingBot): boolean {
  if (bot.status === "failed") return GONE_STATES.has(bot.state);
  return (
    bot.status === "ingested" &&
    (bot.tasks_failed === true || bot.action_items_count === 0)
  );
}

function statusKey(bot: MeetingBot): string {
  if (bot.status === "ingested" && bot.tasks_failed)
    return "meetingBot.status.tasksFailed";
  if (bot.status === "ingested") return "meetingBot.status.ingested";
  if (bot.status === "no_transcript") return "meetingBot.status.noTranscript";
  // Someone wrote "NoteZat borrar" in the meeting chat: nothing was kept.
  if (bot.status === "discarded") return "meetingBot.status.discarded";
  if (bot.status === "failed" || bot.state === "fatal_error")
    return "meetingBot.status.failed";
  if (bot.status === "processing" || bot.state === "ended")
    return "meetingBot.status.processing";
  if (bot.state === "waiting_room") return "meetingBot.status.waitingRoom";
  if (inMeeting(bot)) return "meetingBot.status.inMeeting";
  if (bot.state === "leaving" || bot.state === "post_processing")
    return "meetingBot.status.leaving";
  return "meetingBot.status.joining";
}

function formatMeetingTime(iso: string): string {
  return formatDayMonthYearTime(new Date(iso));
}

function statusTone(bot: MeetingBot): string {
  if (bot.status === "ingested" && bot.tasks_failed) return "text-red-500";
  if (bot.status === "ingested") return "text-green-500";
  if (bot.status === "failed" || bot.state === "fatal_error")
    return "text-red-500";
  if (bot.status === "no_transcript" || bot.status === "discarded")
    return "text-mid-gray";
  return "text-blue-500";
}

/// Sends the NoteZat bot to a Meet/Teams/Zoom link: the host admits
/// it and, when the meeting ends, its tasks show up for review like those of
/// a recording, without anyone pressing record.
export function MeetingBotPanel() {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [isDaily, setIsDaily] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bots, setBots] = useState<MeetingBot[]>([]);
  // null until the server says whether it can send bots: hidden meanwhile.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [botSettings, setBotSettings] = useState<MeetingBotSettings | null>(
    null,
  );
  const [savingMode, setSavingMode] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await commands.cloudListMeetingBots();
      if (res.status === "ok") {
        setBots(res.data.bots.slice(0, SHOWN_BOTS));
        setEnabled(res.data.enabled);
      } else if (res.error.includes("does not support the meeting bot")) {
        setEnabled(false);
      }
    } catch {
      // Offline: keep what is shown and try again on the next poll.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    commands
      .cloudGetMeetingBotSettings()
      .then((res) => res.status === "ok" && setBotSettings(res.data))
      .catch(() => undefined);
  }, [enabled]);

  const anyActive = bots.some((b) => !isFinished(b));
  const autoJoinOn = (botSettings?.auto_join ?? "off") !== "off";
  useEffect(() => {
    if (!anyActive && !autoJoinOn) return;
    const timer = setInterval(
      () => void refresh(),
      anyActive ? POLL_MS : AUTO_JOIN_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [anyActive, autoJoinOn, refresh]);

  const setAutoJoin = async (mode: string) => {
    if (savingMode || mode === botSettings?.auto_join) return;
    setSavingMode(true);
    setError(null);
    try {
      const res = await commands.cloudSetMeetingBotAutoJoin(mode);
      if (res.status === "ok") setBotSettings(res.data);
      else setError(res.error);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingMode(false);
    }
  };

  const send = async () => {
    if (!url.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await commands.cloudSendMeetingBot(
        url.trim(),
        title.trim(),
        isDaily,
      );
      if (res.status === "ok") {
        setBots((prev) => [res.data, ...prev].slice(0, SHOWN_BOTS));
        setUrl("");
        setTitle("");
        setIsDaily(false);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const remove = async (botId: string) => {
    const res = await commands.cloudRemoveMeetingBot(botId);
    if (res.status === "ok") {
      setBots((prev) => prev.map((b) => (b.bot_id === botId ? res.data : b)));
    } else {
      setError(res.error);
    }
  };

  const retry = async (botId: string) => {
    setError(null);
    const res = await commands.cloudRetryMeetingBot(botId);
    if (res.status === "ok") {
      setBots((prev) => prev.map((b) => (b.bot_id === botId ? res.data : b)));
    } else {
      setError(res.error);
    }
  };

  if (!enabled) return null;

  return (
    <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Bot className="w-5 h-5" />
          {t("meetingBot.title")}
        </h2>
        <p className="text-sm text-mid-gray">{t("meetingBot.description")}</p>
      </div>

      {/* A meeting in progress comes first: notes, questions and controls. */}
      {bots.filter(inMeeting).map((bot) => (
        <LiveMeetingPanel key={`live-${bot.bot_id}`} botId={bot.bot_id} />
      ))}

      {botSettings && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium flex items-center gap-2">
            <CalendarDays className="w-4 h-4" />
            {t("meetingBot.autoJoin.title")}
          </div>
          <div className="flex rounded-lg border border-mid-gray/30 overflow-hidden text-sm">
            {AUTO_JOIN_MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => void setAutoJoin(mode)}
                disabled={savingMode || !botSettings.calendar_connected}
                className={`flex-1 px-3 py-2 transition disabled:opacity-50 ${
                  botSettings.auto_join === mode
                    ? "bg-logo-primary text-background font-medium"
                    : "hover:bg-mid-gray/10"
                }`}
              >
                {t(`meetingBot.autoJoin.${mode}`)}
              </button>
            ))}
          </div>
          {!botSettings.calendar_connected ? (
            <p className="text-xs text-mid-gray">
              {t("meetingBot.autoJoin.noCalendar")}
            </p>
          ) : (
            <>
              <p className="text-xs text-mid-gray">
                {t("meetingBot.autoJoin.hint")}
              </p>
              {botSettings.upcoming.length === 0 ? (
                <p className="text-xs text-mid-gray">
                  {t("meetingBot.autoJoin.noUpcoming")}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {botSettings.upcoming.slice(0, SHOWN_UPCOMING).map((m) => (
                    <li
                      key={m.event_id}
                      className="flex items-center gap-3 text-xs"
                    >
                      <span className="text-mid-gray tabular-nums shrink-0">
                        {formatMeetingTime(m.start)}
                      </span>
                      <span className="flex-1 truncate">
                        {m.title || m.meeting_url}
                      </span>
                      <span
                        className={
                          m.bot_joins ? "text-green-500" : "text-mid-gray"
                        }
                      >
                        {t(
                          m.bot_joins
                            ? "meetingBot.autoJoin.botJoins"
                            : "meetingBot.autoJoin.noBot",
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 pt-3 border-t border-mid-gray/15">
        <div className="text-sm font-medium">{t("meetingBot.manualTitle")}</div>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          placeholder={t("meetingBot.urlPlaceholder")}
          className="w-full px-3 py-2 rounded-lg border border-mid-gray/30 bg-transparent text-sm"
          disabled={sending}
        />
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("meetingBot.titlePlaceholder")}
          className="w-full px-3 py-2 rounded-lg border border-mid-gray/30 bg-transparent text-sm"
          disabled={sending}
        />
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
            <input
              type="checkbox"
              checked={isDaily}
              onChange={() => setIsDaily(!isDaily)}
              className="accent-lezat-sage"
              disabled={sending}
            />
            <ListChecks className="w-4 h-4" />
            <span>{t("meetingBot.daily")}</span>
          </label>
          <button
            onClick={() => void send()}
            disabled={!url.trim() || sending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-logo-primary text-background text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            {t("meetingBot.send")}
          </button>
        </div>
        <p className="text-xs text-mid-gray">{t("meetingBot.admitHint")}</p>
        <p className="text-xs text-mid-gray">{t("meetingBot.commandsHint")}</p>
      </div>

      {error && (
        <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/5 rounded p-2">
          {error}
        </div>
      )}

      {bots.length > 0 && (
        <ul className="flex flex-col gap-2 pt-3 border-t border-mid-gray/15">
          {bots.map((bot) => (
            <li key={bot.bot_id} className="flex items-center gap-3 text-sm">
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  {bot.title || bot.meeting_url}
                  {bot.source === "calendar" && (
                    <span className="ml-2 text-xs text-mid-gray">
                      {t("meetingBot.fromCalendar")}
                    </span>
                  )}
                </div>
                <div className={`text-xs ${statusTone(bot)}`}>
                  {t(statusKey(bot), {
                    count: bot.action_items_count,
                    error: bot.error ?? "",
                  })}
                </div>
              </div>
              {!isFinished(bot) && !GONE_STATES.has(bot.state) && (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-mid-gray shrink-0" />
                  {inMeeting(bot) && (
                    <button
                      onClick={() => void remove(bot.bot_id)}
                      className="flex items-center gap-1 text-xs text-mid-gray hover:text-red-500 shrink-0"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      {t("meetingBot.remove")}
                    </button>
                  )}
                </>
              )}
              {isFinished(bot) && canRetry(bot) && (
                <button
                  onClick={() => void retry(bot.bot_id)}
                  className="flex items-center gap-1 text-xs text-mid-gray hover:text-logo-primary shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t("meetingBot.retry")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
