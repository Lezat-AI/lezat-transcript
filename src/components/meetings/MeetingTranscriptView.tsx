import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingChunk } from "@/bindings";

export type Speaker = "mic" | "system";

/// One normalized piece of the transcript: a single chunk with its speaker
/// and offset. Every view (dialog, timeline, plain text) and every Copy
/// format consumes this array, so speaker-attribution fixes only need to
/// change `buildSegments`.
export type TranscriptSegment = {
  source: Speaker;
  startMs: number;
  text: string;
};

/// Single entry point from raw chunks to normalized segments: sorted by
/// time, empty chunks dropped. Speaker attribution lives here.
export function buildSegments(chunks: MeetingChunk[]): TranscriptSegment[] {
  return [...chunks]
    .sort((a, b) => a.offset_ms - b.offset_ms)
    .map((c) => ({
      source: (c.source === "system" ? "system" : "mic") as Speaker,
      startMs: c.offset_ms,
      text: c.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text.length > 0);
}

/// A "turn" in the dialog view: consecutive segments from the same source
/// merged into a single bubble. Two consecutive mic chunks 4 seconds apart
/// read more naturally as one block than two — matches how chat UIs render
/// rapid-fire messages from the same speaker.
type DialogTurn = TranscriptSegment;

export function buildDialogTurns(segments: TranscriptSegment[]): DialogTurn[] {
  const out: DialogTurn[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.source === s.source) {
      last.text = `${last.text} ${s.text}`;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/// `mm:ss`, or `h:mm:ss` once the offset passes one hour.
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type TranscriptViewMode = "dialog" | "timeline" | "plain";

export const TRANSCRIPT_VIEW_MODES: readonly TranscriptViewMode[] = [
  "dialog",
  "timeline",
  "plain",
];

const VIEW_MODE_STORAGE_KEY = "lezat.transcriptViewMode";

/// Last view the user picked, remembered across sessions. Falls back to
/// "dialog" when storage is unavailable or holds an unknown value.
export function loadTranscriptViewMode(): TranscriptViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (v && (TRANSCRIPT_VIEW_MODES as readonly string[]).includes(v)) {
      return v as TranscriptViewMode;
    }
  } catch {
    // Storage blocked — use the default.
  }
  return "dialog";
}

export function saveTranscriptViewMode(mode: TranscriptViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Non-critical preference; ignore.
  }
}

type SpeakerLabels = { mic: string; system: string };

/// Plain-text rendering of what each view shows, for the Copy button.
/// - dialog:   one paragraph per turn, "SPEAKER: text"
/// - timeline: one line per segment, "[mm:ss] SPEAKER: text"
/// - plain:    one paragraph per turn, text only
export function formatTranscriptForCopy(
  chunks: MeetingChunk[],
  mode: TranscriptViewMode,
  labels: SpeakerLabels,
  fallbackText = "",
): string {
  const segments = buildSegments(chunks);
  if (segments.length === 0) return fallbackText;
  switch (mode) {
    case "dialog":
      return buildDialogTurns(segments)
        .map((t) => `${labels[t.source]}: ${t.text}`)
        .join("\n\n");
    case "timeline":
      return segments
        .map(
          (s) => `[${formatOffset(s.startMs)}] ${labels[s.source]}: ${s.text}`,
        )
        .join("\n");
    case "plain":
      return buildDialogTurns(segments)
        .map((t) => t.text)
        .join("\n\n");
  }
}

/// Legacy export kept for existing callers: merged turns with timestamps and
/// English speaker labels.
export function formatDialogAsText(chunks: MeetingChunk[]): string {
  return buildDialogTurns(buildSegments(chunks))
    .map(
      (t) =>
        `[${formatOffset(t.startMs)}] ${t.source === "mic" ? "YOU" : "THEM"}: ${t.text}`,
    )
    .join("\n");
}

interface MeetingTranscriptViewProps {
  chunks: MeetingChunk[];
  transcriptText: string;
  /// Override the initial view mode. Callers that want to control mode
  /// externally (e.g. to drive Copy button labels) can pass mode/onChange.
  mode?: TranscriptViewMode;
  onModeChange?: (m: TranscriptViewMode) => void;
}

/// Shared transcript renderer with three views: dialog (chat bubbles),
/// timeline (every segment with its timestamp) and plain text. The toggle
/// is hidden when chunks is empty — legacy meetings recorded before chunked
/// persistence only have concatenated transcript_text.
export const MeetingTranscriptView: React.FC<MeetingTranscriptViewProps> = ({
  chunks,
  transcriptText,
  mode,
  onModeChange,
}) => {
  const { t } = useTranslation();
  const [internalMode, setInternalMode] = useState<TranscriptViewMode>(
    loadTranscriptViewMode,
  );
  const viewMode = mode ?? internalMode;
  const setMode = (m: TranscriptViewMode) => {
    if (onModeChange) onModeChange(m);
    else {
      setInternalMode(m);
      saveTranscriptViewMode(m);
    }
  };

  const segments = buildSegments(chunks);
  const hasSegments = segments.length > 0;
  const speaker = (s: Speaker) =>
    s === "mic"
      ? t("transcriptView.speakers.mic")
      : t("transcriptView.speakers.system");

  const empty = (
    <span className="italic text-mid-gray">{t("transcriptView.empty")}</span>
  );

  let body: React.ReactNode;
  if (!hasSegments) {
    body = (
      <div className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto select-text">
        {transcriptText || empty}
      </div>
    );
  } else if (viewMode === "dialog") {
    body = (
      <div className="flex flex-col gap-2 max-h-96 overflow-y-auto pr-1">
        {buildDialogTurns(segments).map((turn, idx) => {
          const isYou = turn.source === "mic";
          return (
            <div
              key={idx}
              className={
                "flex flex-col max-w-[80%] " +
                (isYou ? "self-end items-end" : "self-start items-start")
              }
            >
              <div
                className={
                  "rounded-2xl px-3 py-1.5 text-sm leading-relaxed whitespace-pre-wrap " +
                  (isYou
                    ? "bg-lezat-sage/25 text-text rounded-br-sm"
                    : "bg-mid-gray/15 text-text rounded-bl-sm")
                }
              >
                {turn.text}
              </div>
              <div className="text-[10px] text-mid-gray mt-0.5 px-1">
                {speaker(turn.source)} · {formatOffset(turn.startMs)}
              </div>
            </div>
          );
        })}
      </div>
    );
  } else if (viewMode === "timeline") {
    body = (
      <ol className="flex flex-col max-h-96 overflow-y-auto pr-1 text-sm select-text">
        {segments.map((seg, idx) => (
          <li
            key={idx}
            className="grid grid-cols-[4.5rem_4rem_1fr] gap-2 py-1 border-b border-mid-gray/10 last:border-b-0"
          >
            <span className="font-mono text-xs text-mid-gray tabular-nums pt-0.5">
              {formatOffset(seg.startMs)}
            </span>
            <span
              className={
                "text-[10px] font-semibold uppercase tracking-wide pt-1 " +
                (seg.source === "mic" ? "text-text" : "text-mid-gray")
              }
            >
              {speaker(seg.source)}
            </span>
            <span className="leading-relaxed">{seg.text}</span>
          </li>
        ))}
      </ol>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3 text-sm leading-relaxed max-h-96 overflow-y-auto pr-1 select-text">
        {buildDialogTurns(segments).map((turn, idx) => (
          <p key={idx}>{turn.text}</p>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {hasSegments && (
        <div
          role="tablist"
          className="flex items-center gap-1 self-start p-1 rounded-md border border-mid-gray/20 text-xs"
        >
          {TRANSCRIPT_VIEW_MODES.map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={viewMode === m}
              onClick={() => setMode(m)}
              title={t(`transcriptView.modes.${m}.hint`)}
              className={
                "px-2.5 py-0.5 rounded transition-colors " +
                (viewMode === m
                  ? "bg-lezat-sage text-[#0d0d1a] font-medium"
                  : "hover:bg-mid-gray/10 text-mid-gray")
              }
            >
              {t(`transcriptView.modes.${m}.label`)}
            </button>
          ))}
        </div>
      )}
      {body}
    </div>
  );
};

export default MeetingTranscriptView;
