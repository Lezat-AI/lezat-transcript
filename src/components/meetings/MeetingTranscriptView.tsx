import React, { useState } from "react";
import type { MeetingChunk } from "@/bindings";

/// A "turn" in the dialog view: consecutive chunks from the same source
/// merged into a single bubble. Two consecutive mic chunks 4 seconds apart
/// read more naturally as one block than two — matches how chat UIs render
/// rapid-fire messages from the same speaker.
type DialogTurn = {
  source: "mic" | "system";
  startMs: number;
  text: string;
};

export function buildDialogTurns(chunks: MeetingChunk[]): DialogTurn[] {
  const sorted = [...chunks].sort((a, b) => a.offset_ms - b.offset_ms);
  const out: DialogTurn[] = [];
  for (const c of sorted) {
    const src: "mic" | "system" = c.source === "system" ? "system" : "mic";
    const last = out[out.length - 1];
    if (last && last.source === src) {
      last.text = `${last.text} ${c.text}`.replace(/\s+/g, " ").trim();
    } else {
      out.push({ source: src, startMs: c.offset_ms, text: c.text.trim() });
    }
  }
  return out;
}

export function formatOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

/// Format dialog turns as plain text suitable for clipboard / Notion / Slack.
/// Used by both the Meetings and Library detail views' Copy buttons.
export function formatDialogAsText(chunks: MeetingChunk[]): string {
  return buildDialogTurns(chunks)
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
  mode?: "dialog" | "plain";
  onModeChange?: (m: "dialog" | "plain") => void;
}

/// Shared transcript renderer. Toggle hidden when chunks is empty —
/// legacy meetings recorded before chunked persistence only have
/// concatenated transcript_text, so dialog view has nothing to render.
export const MeetingTranscriptView: React.FC<MeetingTranscriptViewProps> = ({
  chunks,
  transcriptText,
  mode,
  onModeChange,
}) => {
  const [internalMode, setInternalMode] = useState<"dialog" | "plain">("dialog");
  const viewMode = mode ?? internalMode;
  const setMode = (m: "dialog" | "plain") => {
    if (onModeChange) onModeChange(m);
    else setInternalMode(m);
  };

  const hasChunks = chunks.length > 0;

  return (
    <div className="flex flex-col gap-2">
      {hasChunks && (
        <div className="flex items-center gap-1 self-start p-1 rounded-md border border-mid-gray/20 text-xs">
          {(["dialog", "plain"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={
                "px-2.5 py-0.5 rounded transition-colors " +
                (viewMode === m
                  ? "bg-lezat-sage text-[#0d0d1a] font-medium"
                  : "hover:bg-mid-gray/10 text-mid-gray")
              }
            >
              {m === "dialog" ? "Dialog" : "Plain"}
            </button>
          ))}
        </div>
      )}

      {hasChunks && viewMode === "dialog" ? (
        <div className="flex flex-col gap-2 max-h-96 overflow-y-auto pr-1">
          {buildDialogTurns(chunks).map((turn, idx) => {
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
                  {isYou ? "YOU" : "THEM"} · {formatOffset(turn.startMs)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
          {transcriptText || (
            <span className="italic text-mid-gray">(no transcript)</span>
          )}
        </div>
      )}
    </div>
  );
};

export default MeetingTranscriptView;
