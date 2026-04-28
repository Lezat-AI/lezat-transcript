import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Search,
  Trash2,
  Download,
  Star,
  RotateCcw,
  FolderOpen,
  Check,
  Copy,
} from "lucide-react";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
  type MeetingChunk,
  type MeetingRecord,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { AudioPlayer } from "../ui/AudioPlayer";
import { Button } from "../ui/Button";
import {
  MeetingTranscriptView,
  formatDialogAsText,
} from "../meetings/MeetingTranscriptView";

/// Unified "Library" view — the single canonical browser for everything the
/// app captures: dictations and meeting recordings. All power-user actions
/// (audio playback, retry transcription, star, download, dialog view) live
/// here so users don't have to remember which tab to open.

type LibraryKind = "dictation" | "meeting";

interface LibraryItem {
  kind: LibraryKind;
  id: number;
  title: string;
  timestamp: number;
  duration_ms?: number;
  transcript: string;
  /// For meetings only: dir holding mic.wav / system.wav.
  audio_path?: string | null;
  /// For meetings only: per-source timestamped chunks. Drives dialog view.
  chunks?: MeetingChunk[];
  /// For dictations only: file name in the recordings dir, used to look up
  /// the audio blob lazily via the Rust side.
  file_name?: string;
  /// For dictations only: pinned/starred flag.
  saved?: boolean;
  /// For dictations only: original transcription text (post-process variant
  /// is what `transcript` holds when present).
  transcription_text?: string;
}

type Filter = "all" | "dictation" | "meeting";

function fromDictation(entry: HistoryEntry): LibraryItem {
  return {
    kind: "dictation",
    id: entry.id,
    title: entry.title,
    timestamp: entry.timestamp,
    transcript: entry.post_processed_text || entry.transcription_text || "",
    file_name: entry.file_name,
    saved: entry.saved,
    transcription_text: entry.transcription_text,
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

export function LibraryPage() {
  const osType = useOsType();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [meetingViewMode, setMeetingViewMode] = useState<"dialog" | "plain">(
    "dialog",
  );
  const [retryingIds, setRetryingIds] = useState<Set<number>>(new Set());
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
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
      (a, b) => b.timestamp - a.timestamp,
    );
    setItems(merged);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates from both stores.
  useEffect(() => {
    const unsubs = [
      events.historyUpdatePayload.listen((evt) => {
        const p: HistoryUpdatePayload = evt.payload;
        if (p.action === "added" || p.action === "updated") {
          // Cheap: refetch. Could be optimised but the surface is small.
          refresh();
        }
      }),
      listen("meeting-state-event", () => refresh()),
      listen("meeting-transcript-chunk-event", () => refresh()),
    ];
    return () => {
      unsubs.forEach((p) => p.then((fn: () => void) => fn()).catch(() => undefined));
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

  const handleCopy = (item: LibraryItem) => {
    let text = item.transcript;
    if (
      item.kind === "meeting" &&
      meetingViewMode === "dialog" &&
      (item.chunks?.length ?? 0) > 0
    ) {
      text = formatDialogAsText(item.chunks!);
    }
    navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedId(item.id);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedId(null), 1500);
  };

  const handleToggleSaved = async (item: LibraryItem) => {
    if (item.kind !== "dictation") return;
    // Optimistic flip.
    setItems((prev) =>
      prev.map((it) =>
        it.kind === "dictation" && it.id === item.id
          ? { ...it, saved: !it.saved }
          : it,
      ),
    );
    if (selected?.kind === "dictation" && selected.id === item.id) {
      setSelected({ ...selected, saved: !selected.saved });
    }
    const res = await commands.toggleHistoryEntrySaved(item.id);
    if (res.status !== "ok") refresh(); // revert on failure via refetch
  };

  const handleRetry = async (item: LibraryItem) => {
    if (item.kind !== "dictation") return;
    setRetryingIds((prev) => new Set(prev).add(item.id));
    try {
      const res = await commands.retryHistoryEntryTranscription(item.id);
      if (res.status !== "ok") toast.error("Retry failed");
    } finally {
      setRetryingIds((prev) => {
        const n = new Set(prev);
        n.delete(item.id);
        return n;
      });
      refresh();
    }
  };

  // Lazy audio loader for dictation entries — Rust resolves the absolute
  // path (audio lives in app data outside the fs scope), we wrap it for
  // the WebView. Linux can't use convertFileSrc reliably, fall back to a
  // blob URL.
  const getDictationAudioUrl = useCallback(
    async (fileName: string): Promise<string | null> => {
      try {
        const res = await commands.getAudioFilePath(fileName);
        if (res.status !== "ok") return null;
        if (osType === "linux") {
          const data = await readFile(res.data);
          const blob = new Blob([data], { type: "audio/wav" });
          return URL.createObjectURL(blob);
        }
        return convertFileSrc(res.data, "asset");
      } catch (err) {
        console.warn("getDictationAudioUrl failed", err);
        return null;
      }
    },
    [osType],
  );

  const openRecordingsFolder = async () => {
    try {
      const res = await commands.openRecordingsFolder();
      if (res.status !== "ok") console.warn(res.error);
    } catch (err) {
      console.warn("openRecordingsFolder failed", err);
    }
  };

  return (
    <div className="w-full max-w-4xl flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Library</h2>
          <Button
            onClick={openRecordingsFolder}
            variant="secondary"
            size="sm"
            className="flex items-center gap-2"
            title="Open the folder containing both recordings/ (dictations) and meetings/ (meeting audio)"
          >
            <FolderOpen className="w-4 h-4" />
            <span>Open audio folder</span>
          </Button>
        </div>
        <p className="text-sm text-mid-gray">
          Everything you've captured — dictations and meetings — in one place.
          Audio playback, retries, downloads, all here.
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
            const isDictation = item.kind === "dictation";
            const isRetrying = retryingIds.has(item.id);
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
                    <div className="text-sm font-medium truncate flex items-center gap-1.5">
                      {isDictation && item.saved && (
                        <Star
                          className="w-3 h-3 text-logo-primary shrink-0"
                          fill="currentColor"
                        />
                      )}
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
                          console.warn("card download failed", err);
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
                  <div className="px-4 pb-4 pt-2 bg-mid-gray/5 flex flex-col gap-3">
                    {/* Transcript area: meetings get the dialog/plain
                        toggle, dictations get plain text. */}
                    {item.kind === "meeting" ? (
                      <MeetingTranscriptView
                        chunks={item.chunks ?? []}
                        transcriptText={item.transcript}
                        mode={meetingViewMode}
                        onModeChange={setMeetingViewMode}
                      />
                    ) : (
                      <div className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
                        {isRetrying ? (
                          <span className="italic text-mid-gray">
                            Re-transcribing…
                          </span>
                        ) : item.transcript ? (
                          item.transcript
                        ) : (
                          <span className="italic text-mid-gray">
                            (no transcript)
                          </span>
                        )}
                      </div>
                    )}

                    {/* Audio. Dictation uses a single lazy player keyed
                        off file_name. Meeting shows two players (mic +
                        system) when audio_path exists. */}
                    {isDictation && item.file_name && (
                      <AudioPlayer
                        onLoadRequest={() =>
                          getDictationAudioUrl(item.file_name!)
                        }
                        className="w-full"
                      />
                    )}
                    {item.kind === "meeting" && item.audio_path && (
                      <div className="flex flex-col gap-2 pt-1 border-t border-mid-gray/15">
                        <h4 className="text-xs font-bold uppercase tracking-wide text-mid-gray">
                          Audio
                        </h4>
                        {[
                          { label: "Microphone (YOU)", track: "mic" as const, file: "mic.wav" },
                          { label: "System audio (THEM)", track: "system" as const, file: "system.wav" },
                        ].map((s) => {
                          const join = (a: string, b: string) =>
                            a.endsWith("/") ? a + b : a + "/" + b;
                          const url = convertFileSrc(
                            join(item.audio_path!, s.file),
                          );
                          return (
                            <div key={s.label} className="flex items-center gap-3">
                              <span className="text-xs text-mid-gray w-40 shrink-0">
                                {s.label}
                              </span>
                              <AudioPlayer src={url} className="flex-1" />
                              <button
                                onClick={async () => {
                                  try {
                                    await downloadMeetingAudio(
                                      item.id,
                                      s.track,
                                      `${item.title} — ${s.file}`,
                                    );
                                  } catch (err) {
                                    console.warn("download failed", err);
                                  }
                                }}
                                className="p-1.5 text-mid-gray hover:text-text rounded"
                                title={`Download ${s.file}`}
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Action row */}
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => handleCopy(item)}
                        disabled={!item.transcript}
                        className="text-xs px-2 py-1 rounded border border-mid-gray/30 hover:bg-mid-gray/10 disabled:opacity-40 inline-flex items-center gap-1"
                      >
                        {copiedId === item.id ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {item.kind === "meeting" &&
                        meetingViewMode === "dialog" &&
                        (item.chunks?.length ?? 0) > 0
                          ? "Copy dialog"
                          : "Copy transcript"}
                      </button>

                      {isDictation && (
                        <>
                          <button
                            onClick={() => handleToggleSaved(item)}
                            className={
                              "text-xs px-2 py-1 rounded border border-mid-gray/30 hover:bg-mid-gray/10 inline-flex items-center gap-1 " +
                              (item.saved ? "text-logo-primary" : "")
                            }
                          >
                            <Star
                              className="w-3 h-3"
                              fill={item.saved ? "currentColor" : "none"}
                            />
                            {item.saved ? "Saved" : "Save"}
                          </button>
                          <button
                            onClick={() => handleRetry(item)}
                            disabled={isRetrying}
                            className="text-xs px-2 py-1 rounded border border-mid-gray/30 hover:bg-mid-gray/10 disabled:opacity-40 inline-flex items-center gap-1"
                          >
                            <RotateCcw
                              className={
                                "w-3 h-3 " + (isRetrying ? "animate-spin" : "")
                              }
                            />
                            {isRetrying ? "Retrying…" : "Retry transcription"}
                          </button>
                        </>
                      )}
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
