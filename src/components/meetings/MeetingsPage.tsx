import React, { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Mic, Square, Trash2, Loader2, Speaker, ExternalLink, Save, Pencil } from "lucide-react";
import { commands } from "@/bindings";
import type { MeetingRecord, MeetingChunk, SystemAudioAvailability } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { AudioPlayer } from "../ui/AudioPlayer";

function meetingAudioSources(audioPath: string | null): { label: string; url: string }[] {
  if (!audioPath) return [];
  // Audio path is a directory holding mic.wav and optionally system.wav.
  const join = (a: string, b: string) => (a.endsWith("/") ? a + b : a + "/" + b);
  return [
    { label: "Microphone (YOU)", url: convertFileSrc(join(audioPath, "mic.wav")) },
    { label: "System audio (THEM)", url: convertFileSrc(join(audioPath, "system.wav")) },
  ];
}

// Event names are generated from the Rust struct names (kebab-case).
const EVT_CHUNK = "meeting-transcript-chunk-event";
const EVT_STATE = "meeting-state-event";

type StatePayload =
  | { state: "started"; meeting_id: number; title: string }
  | { state: "stopped"; meeting_id: number }
  | { state: "error"; meeting_id: number | null; message: string };

type ChunkPayload = {
  meeting_id: number;
  chunk: MeetingChunk;
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatStartedAt(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function InlineTitle({
  initial,
  subtitle,
  onRename,
}: {
  initial: string;
  subtitle?: string;
  onRename: (next: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);

  if (editing) {
    return (
      <div className="flex-1 min-w-0">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={async () => {
            const next = value.trim();
            if (next && next !== initial) {
              await onRename(next);
            } else {
              setValue(initial);
            }
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setValue(initial);
              setEditing(false);
            }
          }}
          className="text-base font-bold bg-transparent border-b border-logo-primary focus:outline-none w-full"
        />
        {subtitle && <p className="text-xs text-mid-gray mt-1">{subtitle}</p>}
      </div>
    );
  }
  return (
    <div className="flex-1 min-w-0">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group text-left flex items-center gap-1.5"
        title="Click to rename"
      >
        <h3 className="text-base font-bold truncate">{initial}</h3>
        <Pencil className="w-3.5 h-3.5 text-mid-gray opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </button>
      {subtitle && <p className="text-xs text-mid-gray">{subtitle}</p>}
    </div>
  );
}

export function MeetingsPage() {
  const { settings, updateSetting } = useSettings();
  const captureSystemAudio = settings?.capture_system_audio ?? false;
  const saveMeetingAudio = settings?.save_meeting_audio ?? false;

  const [activeId, setActiveId] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveChunks, setLiveChunks] = useState<MeetingChunk[]>([]);
  const [pastMeetings, setPastMeetings] = useState<MeetingRecord[]>([]);
  const [viewing, setViewing] = useState<MeetingRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sysAudio, setSysAudio] = useState<SystemAudioAvailability | null>(null);

  const elapsedStart = useRef<number | null>(null);
  const liveEndRef = useRef<HTMLDivElement | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const res = await commands.listMeetings(200);
      if (res.status === "ok") setPastMeetings(res.data);
    } catch (e) {
      console.warn("listMeetings failed", e);
    }
  }, []);

  // Pick up any already-running meeting when the page mounts (hot reload case).
  useEffect(() => {
    (async () => {
      try {
        const active = await commands.meetingActive();
        if (active !== null && active !== undefined) {
          setActiveId(active);
          elapsedStart.current = Date.now();
        }
      } catch {
        /* noop */
      }
      refreshList();
    })();
  }, [refreshList]);

  // Probe the system-audio capture path (BlackHole on macOS, WASAPI on Windows
  // once wired, PulseAudio monitor on Linux) so we can show a helpful status.
  // Re-probe when the user toggles the setting — e.g. they just installed
  // BlackHole and want to see it go green.
  useEffect(() => {
    let active = true;
    commands.getSystemAudioAvailability().then((s) => {
      if (active) setSysAudio(s);
    });
    return () => {
      active = false;
    };
  }, [captureSystemAudio]);

  // Elapsed timer tick.
  useEffect(() => {
    if (activeId === null) {
      setElapsedMs(0);
      elapsedStart.current = null;
      return;
    }
    if (elapsedStart.current === null) elapsedStart.current = Date.now();
    const t = setInterval(() => {
      if (elapsedStart.current !== null) {
        setElapsedMs(Date.now() - elapsedStart.current);
      }
    }, 250);
    return () => clearInterval(t);
  }, [activeId]);

  // Live transcript stream.
  useEffect(() => {
    const p = listen<ChunkPayload>(EVT_CHUNK, (evt) => {
      if (evt.payload.meeting_id !== activeId) return;
      setLiveChunks((prev) => [...prev, evt.payload.chunk]);
    });
    return () => {
      p.then((fn) => fn()).catch(() => undefined);
    };
  }, [activeId]);

  // Lifecycle events.
  useEffect(() => {
    const p = listen<StatePayload>(EVT_STATE, (evt) => {
      const pl = evt.payload;
      if (pl.state === "started") {
        setActiveId(pl.meeting_id);
        setLiveChunks([]);
        elapsedStart.current = Date.now();
      } else if (pl.state === "stopped") {
        setActiveId(null);
        refreshList();
      } else if (pl.state === "error") {
        setError(pl.message);
        setActiveId(null);
      }
    });
    return () => {
      p.then((fn) => fn()).catch(() => undefined);
    };
  }, [refreshList]);

  // Auto-scroll live transcript.
  useEffect(() => {
    liveEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [liveChunks]);

  const handleStart = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await commands.meetingStart(null);
      if (res.status === "ok") {
        setActiveId(res.data);
        setLiveChunks([]);
        elapsedStart.current = Date.now();
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      const res = await commands.meetingStop();
      if (res.status === "ok") {
        setActiveId(null);
        refreshList();
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await commands.deleteMeeting(id);
      if (viewing?.id === id) setViewing(null);
      refreshList();
    } catch (e) {
      console.warn("deleteMeeting failed", e);
    }
  };

  const handleOpen = async (id: number) => {
    const res = await commands.getMeeting(id);
    if (res.status === "ok" && res.data) setViewing(res.data);
  };

  const handleToggleSystemAudio = async () => {
    const next = !captureSystemAudio;
    try {
      await commands.changeCaptureSystemAudioSetting(next);
      updateSetting("capture_system_audio", next);
    } catch (e) {
      console.warn("changeCaptureSystemAudioSetting failed", e);
    }
  };

  const handleToggleSaveAudio = async () => {
    const next = !saveMeetingAudio;
    try {
      await commands.changeSaveMeetingAudioSetting(next);
      updateSetting("save_meeting_audio", next);
    } catch (e) {
      console.warn("changeSaveMeetingAudioSetting failed", e);
    }
  };

  const renderSystemAudioStatus = () => {
    if (!sysAudio) return null;
    if (sysAudio.state === "available") {
      return (
        <div className="text-xs text-lezat-sage flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-lezat-sage" />
          Captured via <span className="font-medium">{sysAudio.label}</span>
        </div>
      );
    }
    if (sysAudio.state === "not_configured") {
      return (
        <div className="text-xs text-amber-500 leading-relaxed">
          {sysAudio.install_hint}
          {sysAudio.install_hint.includes("https://") && (
            <button
              onClick={() =>
                openUrl(
                  sysAudio.install_hint.match(/https?:\/\/\S+/)?.[0] ?? ""
                )
              }
              className="ml-1 inline-flex items-center gap-1 underline"
            >
              open link <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="text-xs text-mid-gray italic">{sysAudio.message}</div>
    );
  };

  return (
    <div className="w-full max-w-3xl flex flex-col gap-6">
      {/* Record/stop panel */}
      <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Meeting Mode</h2>
            <p className="text-sm text-mid-gray">
              Records your microphone and, optionally, the other side of the
              call — then transcribes continuously. Use the checkbox below to
              enable system-audio capture.
            </p>
          </div>
          {activeId !== null && (
            <div className="flex items-center gap-2 text-sm tabular-nums">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span>{formatDuration(elapsedMs)}</span>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          {activeId === null ? (
            <button
              onClick={handleStart}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg bg-logo-primary text-background font-medium hover:opacity-90 disabled:opacity-50 transition"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
              Start Meeting
            </button>
          ) : (
            <button
              onClick={handleStop}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg bg-red-600 text-white font-medium hover:opacity-90 disabled:opacity-50 transition"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Square className="w-4 h-4" />
              )}
              Stop Meeting
            </button>
          )}
        </div>

        {/* Capture + persistence toggles */}
        <div className="flex flex-col gap-2 pt-3 border-t border-mid-gray/15">
          <div className="flex items-start gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={captureSystemAudio}
                onChange={handleToggleSystemAudio}
                className="accent-lezat-sage"
                disabled={activeId !== null}
              />
              <span className="inline-flex items-center gap-1.5 text-sm">
                <Speaker className="w-4 h-4" />
                Also capture the other side of the call
              </span>
            </label>
            <div className="flex-1 min-w-0 pt-0.5">
              {captureSystemAudio && renderSystemAudioStatus()}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
            <input
              type="checkbox"
              checked={saveMeetingAudio}
              onChange={handleToggleSaveAudio}
              className="accent-lezat-sage"
              disabled={activeId !== null}
            />
            <Save className="w-4 h-4" />
            <span>Save meeting audio to disk</span>
            <span className="text-xs text-mid-gray">
              (opt-in — a 45-min meeting is ~80 MB per source)
            </span>
          </label>
        </div>

        {error && (
          <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/5 rounded p-2">
            {error}
          </div>
        )}
      </section>

      {/* Live transcript during active meeting */}
      {activeId !== null && (
        <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-3">
          <h3 className="text-sm font-bold uppercase tracking-wide text-mid-gray">
            Live Transcript
          </h3>
          <div className="max-h-80 overflow-y-auto text-sm leading-relaxed flex flex-col gap-2">
            {liveChunks.length === 0 ? (
              <p className="text-mid-gray italic">
                Listening… the first line usually appears after ~12 seconds of
                audio.
              </p>
            ) : (
              liveChunks.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <span
                    className={
                      "shrink-0 text-[9px] font-bold tracking-widest uppercase py-0.5 px-1.5 rounded " +
                      (c.source === "system"
                        ? "bg-lezat-sage/20 text-lezat-sage"
                        : "bg-logo-primary/15 text-logo-primary")
                    }
                    title={c.source === "system" ? "Other side of the call" : "Your microphone"}
                  >
                    {c.source === "system" ? "THEM" : "YOU"}
                  </span>
                  <span className="flex-1 whitespace-pre-wrap">{c.text}</span>
                </div>
              ))
            )}
            <div ref={liveEndRef} />
          </div>
        </section>
      )}

      {/* Viewing a past meeting */}
      {viewing && (
        <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-3">
          <div className="flex items-start justify-between">
            <InlineTitle
              initial={viewing.title}
              onRename={async (next) => {
                await commands.renameMeeting(viewing.id, next);
                setViewing({ ...viewing, title: next });
                refreshList();
              }}
              subtitle={`${formatStartedAt(viewing.started_at)} · ${formatDuration(viewing.duration_ms)}`}
            />
            <button
              onClick={() => setViewing(null)}
              className="text-xs text-mid-gray hover:underline"
            >
              close
            </button>
          </div>
          <div className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
            {viewing.transcript_text || (
              <span className="italic text-mid-gray">(no transcript)</span>
            )}
          </div>

          {viewing.audio_path && (
            <div className="flex flex-col gap-2 pt-2 border-t border-mid-gray/15">
              <h4 className="text-xs font-bold uppercase tracking-wide text-mid-gray">
                Audio
              </h4>
              {meetingAudioSources(viewing.audio_path).map((s) => (
                <div key={s.label} className="flex items-center gap-3">
                  <span className="text-xs text-mid-gray w-40 shrink-0">
                    {s.label}
                  </span>
                  <AudioPlayer src={s.url} className="flex-1" />
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() =>
                navigator.clipboard?.writeText(viewing.transcript_text)
              }
              className="text-xs px-2 py-1 rounded border border-mid-gray/30 hover:bg-mid-gray/10"
            >
              Copy transcript
            </button>
            <button
              onClick={() => handleDelete(viewing.id)}
              className="text-xs px-2 py-1 rounded border border-red-500/30 text-red-500 hover:bg-red-500/10 flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </div>
        </section>
      )}

      {/* Past meetings list */}
      <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-3">
        <h3 className="text-sm font-bold uppercase tracking-wide text-mid-gray">
          Past Meetings
        </h3>
        {pastMeetings.length === 0 ? (
          <p className="text-sm text-mid-gray italic">
            No meetings yet. Click Start Meeting to record your first one.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-mid-gray/15">
            {pastMeetings.map((m) => (
              <li
                key={m.id}
                className="py-2 flex items-center justify-between cursor-pointer hover:bg-mid-gray/5 px-2 -mx-2 rounded"
                onClick={() => handleOpen(m.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{m.title}</div>
                  <div className="text-xs text-mid-gray">
                    {formatStartedAt(m.started_at)} ·{" "}
                    {formatDuration(m.duration_ms)}
                    {m.transcript_text ? (
                      <>
                        {" · "}
                        <span className="truncate">
                          {m.transcript_text.slice(0, 60)}
                          {m.transcript_text.length > 60 ? "…" : ""}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(m.id);
                  }}
                  className="ml-2 p-1 text-mid-gray hover:text-red-500"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default MeetingsPage;
