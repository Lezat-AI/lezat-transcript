/// Transcript download formats. Every format is built from the same list of
/// entries (who spoke, when, what), so a meeting reads the same in a .txt, a
/// Word document or a subtitle file.

export type TranscriptFormat = "txt" | "md" | "docx" | "srt" | "vtt";

export interface TranscriptEntry {
  speaker?: string;
  /// Offset from the start of the recording; only local meetings have it.
  startMs?: number;
  text: string;
}

export interface TranscriptDocument {
  title: string;
  /// Date and duration, shown under the title.
  subtitle: string;
  entries: TranscriptEntry[];
  /// Length of the recording, used to end the last subtitle.
  durationMs?: number;
}

export const TRANSCRIPT_FORMATS: {
  format: TranscriptFormat;
  label: string;
  hint: string;
  /// Subtitles need a time for every line.
  needsTimes?: boolean;
}[] = [
  {
    format: "txt",
    label: "Texto (.txt)",
    hint: "Para pegar en cualquier lado",
  },
  {
    format: "docx",
    label: "Word (.docx)",
    hint: "Para editar, compartir o imprimir",
  },
  { format: "md", label: "Markdown (.md)", hint: "Para Notion, Obsidian o IA" },
  {
    format: "srt",
    label: "Subtítulos (.srt)",
    hint: "Para videos (Premiere, YouTube…)",
    needsTimes: true,
  },
  {
    format: "vtt",
    label: "Subtítulos web (.vtt)",
    hint: "Para reproductores web",
    needsTimes: true,
  },
];

/// True when every entry has a time, so subtitles can be built.
export function hasTimes(doc: TranscriptDocument): boolean {
  return (
    doc.entries.length > 0 && doc.entries.every((e) => e.startMs !== undefined)
  );
}

/// `mm:ss`, or `h:mm:ss` once past one hour (matches the timeline view).
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/// "[03:12] Daniela Botero", "Daniela Botero", "[03:12]" or "".
export function entryLabel(e: TranscriptEntry): string {
  const time = e.startMs !== undefined ? `[${clock(e.startMs)}]` : "";
  return [time, e.speaker ?? ""].filter(Boolean).join(" ");
}

export function toPlainText(doc: TranscriptDocument): string {
  const body = doc.entries
    .map((e) => {
      const label = entryLabel(e);
      return label ? `${label}: ${e.text}` : e.text;
    })
    .join("\n\n");
  return `${doc.title}\n${doc.subtitle}\n\n${body}\n`;
}

export function toMarkdown(doc: TranscriptDocument): string {
  const body = doc.entries
    .map((e) => {
      const label = entryLabel(e);
      return label ? `**${label}:** ${e.text}` : e.text;
    })
    .join("\n\n");
  return `# ${doc.title}\n\n_${doc.subtitle}_\n\n${body}\n`;
}

/// Longest a subtitle stays on screen when the next line starts much later.
const MAX_CUE_MS = 8000;
const MIN_CUE_MS = 1000;

function cues(doc: TranscriptDocument) {
  const timed = doc.entries.filter((e) => e.startMs !== undefined);
  return timed.map((e, i) => {
    const start = e.startMs ?? 0;
    const next = timed[i + 1]?.startMs ?? doc.durationMs ?? start + MAX_CUE_MS;
    const end = Math.max(
      start + MIN_CUE_MS,
      Math.min(next, start + MAX_CUE_MS),
    );
    const text = e.speaker ? `${e.speaker}: ${e.text}` : e.text;
    return { start, end, text };
  });
}

/// `hh:mm:ss,mmm` (SRT) or `hh:mm:ss.mmm` (WebVTT).
function cueTime(ms: number, sep: "," | "."): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(doc: TranscriptDocument): string {
  return cues(doc)
    .map(
      (c, i) =>
        `${i + 1}\n${cueTime(c.start, ",")} --> ${cueTime(c.end, ",")}\n${c.text}\n`,
    )
    .join("\n");
}

export function toVtt(doc: TranscriptDocument): string {
  const body = cues(doc)
    .map(
      (c) => `${cueTime(c.start, ".")} --> ${cueTime(c.end, ".")}\n${c.text}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/// "[Weekly] Status Proyectos 2026-10-20.docx": no characters a file system rejects.
export function transcriptFileName(
  title: string,
  timestampSeconds: number,
  format: TranscriptFormat,
): string {
  const date = new Date(timestampSeconds * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clean =
    title
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Transcripción";
  return `${clean} ${day}.${format}`;
}
