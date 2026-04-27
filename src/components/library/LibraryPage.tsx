import React, { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Search, Trash2, Download } from "lucide-react";
import {
  commands,
  type HistoryEntry,
  type MeetingChunk,
  type MeetingRecord,
} from "@/bindings";
import {
  MeetingTranscriptView,
  formatDialogAsText,
} from "../meetings/MeetingTranscriptView";

async function downloadMeetingAudio(
  meetingId: number,
  track: "mic" | "system",
  suggestedName: string,
): Promise<void> {
  const dest = await save({
    defaultPath: suggestedName,
    filters: [{ name: "WAV audio", extensions: ["wav"] }],
  });
  if (!dest) return;
  const res = await commands.exportMeetingAudio(meetingId, track, dest);
  if (res.status === "error") {
    console.warn("export_meeting_audio failed:", res.error);
  }
}

/// Unified "Library" view — merges dictation transcripts and meeting recordings
/// into one timeline so users can find anything they've captured without
/// remembering which flow produced it.
///
/// Clicking an entry opens an inline read-only detail panel. Power-user actions
/// (audio playback, retry transcription, star) still live in the dedicated
/// History and Meetings tabs — Library is intentionally minimal.

type LibraryKind = "dictation" | "meeting";

interface LibraryItem {
  kind: LibraryKind;
  id: number;
  title: string;
  timestamp: number; // unix seconds
  duration_ms?: number;
  transcript: string;
  /// For meetings only: path to the directory holding mic.wav / system.wav.
  /// Lets the row offer a download shortcut without a follow-up fetch.
  audio_path?: string | null;
  /// For meetings only: per-source timestamped chunks. Drives the dialog
  /// view in the expanded detail. Empty for legacy meetings recorded
  /// before chunked persistence.
  chunks?: MeetingChunk[];
}

type Filter = "all" | "dictation" | "meeting";

function fromDictation(entry: HistoryEntry): LibraryItem {
  return {
    kind: "dictation",
    id: entry.id,
    title: entry.title,
    timestamp: entry.timestamp,
    transcript: entry.post_processed_text || entry.transcription_text || "",
  };
}

function fromMeeting(rec: MeetingRecord): LibraryItem {
  return {
    kind: "meeting",
    id: rec.id,
    title: rec.title,
    timestamp: rec.started_at,
    duration_ms: rec.duration_ms,
    transcript: rec.transcript_text || "",
    audio_path: rec.audio_path,
    chunks: rec.chunks ?? [],
  };
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function LibraryPage() {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [meetingViewMode, setMeetingViewMode] = useState<"dialog" | "plain">(
    "dialog",
  );

  const refresh = useCallback(async () => {
    // Pull both data sources in parallel. listMeetings is cheap; dictation
    // history is paged but we just grab the first 500 for v1.
    const [histRes, meetingsRes] = await Promise.all([
      commands.getHistoryEntries(null, 500).catch(() => ({
        status: "error" as const,
        error: "fetch failed",
      })),
      commands.listMeetings(500).catch(() => ({
        status: "error" as const,
        error: "fetch failed",
      })),
    ]);

    const dictations: LibraryItem[] =
      histRes.status === "ok" ? histRes.data.entries.map(fromDictation) : [];
    const meetings: LibraryItem[] =
      meetingsRes.status === "ok" ? meetingsRes.data.map(fromMeeting) : [];

    const merged = [...dictations, ...meetings].sort(
      (a, b) => b.timestamp - a.timestamp
    );
    setItems(merged);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live-update when either underlying store emits a mutation event.
  useEffect(() => {
    const unsubs = [
      listen("history-update-payload", () => refresh()),
      listen("meeting-state-event", () => refresh()),
    ];
    return () => {
      unsubs.forEach((p) => p.then((fn) => fn()).catch(() => undefined));
    };
  }, [refresh]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((it) => (filter === "all" ? true : it.kind === filter))
      .filter((it) => {
        if (!q) return true;
        return (
          it.title.toLowerCase().includes(q) ||
          it.transcript.toLowerCase().includes(q)
        );
      });
  }, [items, filter, query]);

  const counts = useMemo(() => {
    const dict = items.filter((i) => i.kind === "dictation").length;
    const meet = items.filter((i) => i.kind === "meeting").length;
    return { all: items.length, dictation: dict, meeting: meet };
  }, [items]);

  const handleDelete = async (item: LibraryItem) => {
    if (item.kind === "meeting") {
      await commands.deleteMeeting(item.id);
    } else {
      await commands.deleteHistoryEntry(item.id);
    }
    if (selected?.id === item.id && selected?.kind === item.kind) {
      setSelected(null);
    }
    refresh();
  };

  const copyTranscript = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  return (
    <div className="w-full max-w-4xl flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold">Library</h2>
        <p className="text-sm text-mid-gray">
          Everything you've captured — dictations and meeting recordings — in
          one searchable timeline.
        </p>
      </header>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg border border-mid-gray/20 text-sm">
          {(["all", "dictation", "meeting"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                "px-3 py-1 rounded-md transition-colors " +
                (filter === f
                  ? "bg-logo-primary text-background"
                  : "hover:bg-mid-gray/10")
              }
            >
              {f === "all"
                ? `All (${counts.all})`
                : f === "dictation"
                  ? `Dictation (${counts.dictation})`
                  : `Meeting (${counts.meeting})`}
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-mid-gray pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles + transcripts"
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-mid-gray/25 bg-transparent focus:border-logo-primary focus:outline-none"
          />
        </div>
      </div>

      {/* Entry list */}
      {visible.length === 0 ? (
        <div className="text-sm text-mid-gray italic py-8 text-center">
          {query
            ? "Nothing matches that search."
            : filter === "all"
              ? "No captures yet. Use push-to-talk (Opt+Space) or start a Meeting to begin."
              : filter === "dictation"
                ? "No dictations yet."
                : "No meetings yet."}
        </div>
      ) : (
        <ul className="flex flex-col rounded-xl border border-mid-gray/20 divide-y divide-mid-gray/15 overflow-hidden">
          {visible.map((item) => {
            const isOpen =
              selected?.id === item.id && selected?.kind === item.kind;
            return (
              <li key={`${item.kind}-${item.id}`}>
                <div
                  className={
                    "flex items-center gap-3 p-3 cursor-pointer transition-colors " +
                    (isOpen ? "bg-mid-gray/10" : "hover:bg-mid-gray/5")
                  }
                  onClick={() => setSelected(isOpen ? null : item)}
                >
                  <TypeChip kind={item.kind} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {item.title}
                    </div>
                    <div className="text-xs text-mid-gray truncate">
                      {formatWhen(item.timestamp)}
                      {item.duration_ms !== undefined
                        ? ` · ${formatDuration(item.duration_ms)}`
                        : ""}
                      {item.transcript
                        ? ` · ${item.transcript.slice(0, 80)}${item.transcript.length > 80 ? "…" : ""}`
                        : ""}
                    </div>
                  </div>
                  {item.kind === "meeting" && item.audio_path && (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await downloadMeetingAudio(
                            item.id,
                            "mic",
                            `${item.title} — mic.wav`,
                          );
                        } catch (err) {
                          console.warn("library card download failed", err);
                        }
                      }}
                      className="ml-1 p-1 text-mid-gray hover:text-text shrink-0"
                      title="Download mic audio"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(item);
                    }}
                    className="ml-1 p-1 text-mid-gray hover:text-red-500 shrink-0"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {isOpen && (
                  <div className="px-4 pb-4 pt-1 bg-mid-gray/5 flex flex-col gap-2">
                    {item.kind === "meeting" ? (
                      <MeetingTranscriptView
                        chunks={item.chunks ?? []}
                        transcriptText={item.transcript}
                        mode={meetingViewMode}
                        onModeChange={setMeetingViewMode}
                      />
                    ) : (
                      <div className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
                        {item.transcript || (
                          <span className="italic text-mid-gray">
                            (no transcript)
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => {
                          // Match Meetings tab: dialog mode → timestamped
                          // "[00:12] YOU: …" format; plain → raw transcript.
                          if (
                            item.kind === "meeting" &&
                            meetingViewMode === "dialog" &&
                            (item.chunks?.length ?? 0) > 0
                          ) {
                            copyTranscript(formatDialogAsText(item.chunks!));
                          } else {
                            copyTranscript(item.transcript);
                          }
                        }}
                        disabled={!item.transcript}
                        className="text-xs px-2 py-1 rounded border border-mid-gray/30 hover:bg-mid-gray/10 disabled:opacity-40"
                      >
                        {item.kind === "meeting" &&
                        meetingViewMode === "dialog" &&
                        (item.chunks?.length ?? 0) > 0
                          ? "Copy dialog"
                          : "Copy transcript"}
                      </button>
                      {item.kind === "meeting" && item.audio_path && (
                        <>
                          <button
                            onClick={async () => {
                              try {
                                await downloadMeetingAudio(
                                  item.id,
                                  "mic",
                                  `${item.title} — mic.wav`,
                                );
                              } catch (err) {
                                console.warn("download mic failed", err);
                              }
                            }}
                            className="text-xs px-2 py-1 rounded border border-mid-gray/30 hover:bg-mid-gray/10 inline-flex items-center gap-1"
                          >
                            <Download className="w-3 h-3" />
                            Mic audio
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await downloadMeetingAudio(
                                  item.id,
                                  "system",
                                  `${item.title} — system.wav`,
                                );
                              } catch (err) {
                                console.warn("download system failed", err);
                              }
                            }}
                            className="text-xs px-2 py-1 rounded border border-mid-gray/30 hover:bg-mid-gray/10 inline-flex items-center gap-1"
                          >
                            <Download className="w-3 h-3" />
                            System audio
                          </button>
                        </>
                      )}
                      <span className="text-xs text-mid-gray self-center italic">
                        {item.kind === "dictation"
                          ? "Power actions (retry, star) live in the History tab"
                          : "Open the Meetings tab for the full timeline"}
                      </span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TypeChip({ kind }: { kind: LibraryKind }) {
  if (kind === "meeting") {
    return (
      <span className="shrink-0 text-[9px] font-bold tracking-widest uppercase py-0.5 px-1.5 rounded bg-lezat-sage/20 text-lezat-sage">
        MEETING
      </span>
    );
  }
  return (
    <span className="shrink-0 text-[9px] font-bold tracking-widest uppercase py-0.5 px-1.5 rounded bg-logo-primary/15 text-logo-primary">
      DICTATION
    </span>
  );
}

export default LibraryPage;
