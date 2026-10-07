import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CalendarDays,
  Headphones,
  Plus,
  Users,
  X,
} from "lucide-react";
import { commands, events } from "@/bindings";
import type { MeetingParticipant, OutputDeviceHint } from "@/bindings";

/// How often to re-check the output device while the panel is visible
/// (people plug in / unplug headphones mid-call).
const OUTPUT_POLL_MS = 10_000;

/// "Ana <ana@x.co>", "ana@x.co" or a plain name → participant.
function parseParticipant(raw: string): MeetingParticipant | null {
  const value = raw.trim();
  if (!value) return null;
  const angled = value.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  if (angled) {
    const email = angled[2].toLowerCase();
    const name = angled[1].trim() || email.split("@")[0];
    return { name, email };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    const email = value.toLowerCase();
    return { name: email.split("@")[0], email };
  }
  return { name: value, email: null };
}

function samePerson(a: MeetingParticipant, b: MeetingParticipant): boolean {
  if (a.email && b.email)
    return a.email.toLowerCase() === b.email.toLowerCase();
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

/// "Use headphones" notice: shown while system audio is captured and the
/// default output looks like speakers. Never blocks anything.
export function HeadphonesNotice({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [hint, setHint] = useState<OutputDeviceHint | null>(null);

  useEffect(() => {
    if (!enabled) {
      setHint(null);
      return;
    }
    let alive = true;
    const probe = () => {
      commands
        .getOutputDeviceHint()
        .then((h) => {
          if (alive) setHint(h);
        })
        .catch(() => undefined);
    };
    probe();
    const timer = setInterval(probe, OUTPUT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);

  if (!enabled || hint?.kind !== "speakers") return null;
  return (
    <div className="flex items-start gap-2 text-sm rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 px-3 py-2">
      <Headphones className="w-4 h-4 mt-0.5 shrink-0" />
      <div>
        <p className="font-medium">{t("meetingContext.headphonesWarning")}</p>
        {hint.name && (
          <p className="text-xs opacity-80">
            {t("meetingContext.headphonesWarningDetail", { device: hint.name })}
          </p>
        )}
      </div>
    </div>
  );
}

/// Whether a calendar (Google/Outlook) is connected: `null` while unknown
/// (not loaded yet, or the backend couldn't be reached).
function useCalendarConnected(): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    commands
      .cloudGetIntegrationsStatus()
      .then((res) => {
        if (!alive || res.status !== "ok") return;
        setConnected(
          res.data.integrations.some(
            (i) => i.connected && i.provider.includes("calendar"),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return connected;
}

/// Calendar match + editable participant list of a meeting, while it is
/// recorded or afterwards (meeting detail). Edits are saved right away and
/// go out with the next upload.
export function MeetingContextPanel({ meetingId }: { meetingId: number }) {
  const { t } = useTranslation();
  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [hasEvent, setHasEvent] = useState(false);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [syncState, setSyncState] = useState<string | null>(null);
  const [editedHere, setEditedHere] = useState(false);
  const [contextDropped, setContextDropped] = useState(false);
  const calendarConnected = useCalendarConnected();

  useEffect(() => {
    let alive = true;
    setEventTitle(null);
    setHasEvent(false);
    setParticipants([]);
    setSyncState(null);
    setEditedHere(false);
    setContextDropped(false);
    commands
      .getMeeting(meetingId)
      .then((res) => {
        if (!alive || res.status !== "ok" || !res.data) return;
        setHasEvent(Boolean(res.data.calendar_event_id));
        setEventTitle(res.data.calendar_event_title ?? null);
        setParticipants(res.data.participants ?? []);
        setSyncState(res.data.sync_state ?? null);
      })
      .catch(() => undefined);

    const unlisten = events.meetingCalendarContextEvent.listen((evt) => {
      if (evt.payload.meeting_id !== meetingId) return;
      setHasEvent(Boolean(evt.payload.calendar_event_id));
      setEventTitle(evt.payload.calendar_event_title);
      setParticipants(evt.payload.participants);
    });
    const unlistenSync = events.cloudSyncEvent.listen((evt) => {
      const p = evt.payload;
      if (p.meeting_id !== meetingId) return;
      if (p.state === "success") setSyncState("synced");
      else if (p.state === "failed") setSyncState("failed");
      else if (p.state === "warning" && p.code === "calendar_context_dropped")
        setContextDropped(true);
    });
    return () => {
      alive = false;
      unlisten.then((fn) => fn()).catch(() => undefined);
      unlistenSync.then((fn) => fn()).catch(() => undefined);
    };
  }, [meetingId]);

  const save = useCallback(
    async (next: MeetingParticipant[]) => {
      setParticipants(next);
      setEditedHere(true);
      try {
        const res = await commands.setMeetingParticipants(meetingId, next);
        setSaveError(res.status !== "ok");
      } catch {
        setSaveError(true);
      }
    },
    [meetingId],
  );

  const add = () => {
    const parsed = parseParticipant(draft);
    setDraft("");
    if (!parsed || participants.some((p) => samePerson(p, parsed))) return;
    void save([...participants, parsed]);
  };

  const remove = (index: number) => {
    void save(participants.filter((_, i) => i !== index));
  };

  return (
    <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <CalendarDays className="w-4 h-4 text-mid-gray shrink-0" />
        {hasEvent ? (
          <span className="truncate">
            {t("meetingContext.detectedMeeting", {
              title: eventTitle || t("meetingContext.untitledEvent"),
            })}
          </span>
        ) : (
          <span className="text-mid-gray">
            {calendarConnected === false
              ? t("meetingContext.connectCalendar")
              : t("meetingContext.noCalendarMeeting")}
          </span>
        )}
        {syncState && (
          <span
            className={`ml-auto shrink-0 text-xs ${
              syncState === "failed" ? "text-red-500" : "text-mid-gray"
            }`}
          >
            {syncState === "synced"
              ? t("meetingContext.syncSynced")
              : syncState === "failed"
                ? t("meetingContext.syncFailed")
                : t("meetingContext.syncPending")}
          </span>
        )}
      </div>

      {contextDropped && (
        <div className="flex items-start gap-2 text-xs rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{t("meetingContext.calendarContextDropped")}</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-mid-gray" />
          <h3 className="text-sm font-bold uppercase tracking-wide text-mid-gray">
            {t("meetingContext.participants")}
          </h3>
        </div>
        <p className="text-xs text-mid-gray">
          {t("meetingContext.participantsHint")}
        </p>
        {participants.length === 0 ? (
          <p className="text-sm text-mid-gray italic">
            {t("meetingContext.noParticipants")}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {participants.map((p, i) => (
              <li
                key={`${p.email ?? p.name}-${i}`}
                className="inline-flex items-center gap-1 rounded-full bg-mid-gray/10 pl-2.5 pr-1 py-0.5 text-sm"
                title={p.email ?? undefined}
              >
                <span>{p.name}</span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="p-0.5 rounded-full hover:bg-mid-gray/20"
                  aria-label={t("meetingContext.remove", { name: p.name })}
                  title={t("meetingContext.remove", { name: p.name })}
                >
                  <X className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("meetingContext.addPlaceholder")}
            className="flex-1 min-w-0 text-sm bg-transparent border border-mid-gray/30 rounded-md px-2 py-1 focus:outline-none focus:border-logo-primary"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="inline-flex items-center gap-1 text-sm px-2.5 py-1 rounded-md border border-mid-gray/30 hover:bg-mid-gray/10 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("meetingContext.add")}
          </button>
        </form>
        {saveError && (
          <p className="text-xs text-red-500">
            {t("meetingContext.saveFailed")}
          </p>
        )}
        {editedHere && syncState === "synced" && !saveError && (
          <p className="text-xs text-mid-gray">
            {t("meetingContext.editedAfterUpload")}
          </p>
        )}
      </div>
    </section>
  );
}

export default MeetingContextPanel;
