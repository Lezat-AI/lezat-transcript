/// Echo removal for dual-source meeting transcripts.
///
/// When a call plays through speakers instead of headphones, the microphone
/// also hears the other participants, so their words show up twice: once on
/// system audio (clean, correctly attributed) and once on the mic (attributed
/// to the user). This strips the mic copy, keeping the system version.
///
/// Conservative by design, so the user's own speech survives when both talk:
/// - only mic text is ever removed, and only where it repeats a run of at
///   least `MIN_ECHO_RUN` words of a system chunk captured around the same
///   time (the chunk before, at, or after), at about the same moment;
/// - words the system audio never said stay, e.g. the user answering while
///   the other person speaks;
/// - a whole mic chunk is dropped only when nothing but echo is left.
///
/// Both sources are transcribed separately, so the same words can come back
/// spelled differently ("Fireflies y FreeDayAI, que coloca" on the mic vs.
/// "Firefly y Read AI que coloca" on system audio) and share no 3-word run. A
/// second, fuzzy pass catches those: a whole mic sentence (at least
/// `FUZZY_MIN_WORDS` words) is echo when it is at least `FUZZY_MIN_RATIO`
/// similar (character level, accents and case ignored) to a run of system
/// words said at about the same moment.
///
/// Mirrored by `app/services/echo_filter.py` in the backend; keep in sync.

export type SourcedChunk = {
  offset_ms: number;
  source: string;
  text: string;
};

/// Chunk length used by the recorder (MeetingManager's CHUNK_SECONDS).
const CHUNK_MS = 12_000;
/// System chunks this close (start to start) are compared: previous, same
/// and next chunk. Echo arrives within milliseconds, but the two sources
/// roll their chunks independently, so a phrase can straddle a boundary.
const WINDOW_MS = CHUNK_MS + 3_000;
/// Echo arrives within milliseconds, so a repeated phrase only counts when it
/// sits at about the same moment in both sources. A word's moment is
/// estimated from its position in its chunk; this much slack covers uneven
/// speech rate. Without it, the user repeating the other person a few
/// seconds later ("sí, yo te mando la propuesta el viernes") was deleted.
const ALIGN_MS = 6_000;
/// Words in a row that must match to count as echo (shingle size).
const SHINGLE = 3;
/// Shortest run of matched words removed. Shorter repeats ("sí, claro") are
/// just as likely the user agreeing, so they stay.
const MIN_ECHO_RUN = 4;
/// Up to this many differing words between two echo runs are treated as ASR
/// disagreement (e.g. "Diegui" vs "Diego") and removed with them; the same
/// amount hanging off a chunk edge next to echo is a word cut by the chunk
/// boundary.
const MAX_GAP = 2;
/// Fuzzy pass: only sentences this long (shorter ones, "sí, claro", are as
/// likely the user agreeing) and this similar to aligned system words.
const FUZZY_MIN_WORDS = 5;
const FUZZY_MIN_CHARS = 20;
const FUZZY_MIN_RATIO = 80;
/// System word runs compared to a mic sentence of n words: n-2 .. n+2 words.
const FUZZY_LENGTH_SLACK = 2;
const SENTENCE = /[^.!?…]+[.!?…]*/g;

type Token = { norm: string; start: number; end: number };

/// Spelled-out numbers compare equal to digits ("cinco" = "5"), as ASR
/// writes them either way.
const NUMBER_WORDS: Record<string, string> = {
  cero: "0",
  uno: "1",
  una: "1",
  un: "1",
  dos: "2",
  tres: "3",
  cuatro: "4",
  cinco: "5",
  seis: "6",
  siete: "7",
  ocho: "8",
  nueve: "9",
  diez: "10",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

function normalize(word: string): string {
  const plain = word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return NUMBER_WORDS[plain] ?? plain;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index ?? 0;
    out.push({ norm: normalize(m[0]), start, end: start + m[0].length });
  }
  return out;
}

/// Each shingle with its estimated moment (words spread over the chunk).
function timedShingles(
  offsetMs: number,
  words: string[],
): Array<[string, number]> {
  const count = Math.max(words.length, 1);
  const out: Array<[string, number]> = [];
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    out.push([
      words.slice(i, i + SHINGLE).join(" "),
      offsetMs + (CHUNK_MS * (i + SHINGLE / 2)) / count,
    ]);
  }
  return out;
}

/// Similarity 0..100 like rapidfuzz's `fuzz.ratio`: 2·LCS / (|a| + |b|).
function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (200 * prev[b.length]) / (a.length + b.length);
}

type TimedWord = [string, number];

/// System words around a mic chunk, in order, with their estimated moment.
function nearbySystemWords(
  offsetMs: number,
  system: Array<{ at: number; words: string[] }>,
): TimedWord[] {
  const out: TimedWord[] = [];
  const near = system
    .filter((s) => Math.abs(s.at - offsetMs) <= WINDOW_MS)
    .sort((a, b) => a.at - b.at);
  for (const s of near) {
    const count = Math.max(s.words.length, 1);
    s.words.forEach((w, i) =>
      out.push([w, s.at + (CHUNK_MS * (i + 0.5)) / count]),
    );
  }
  return out;
}

/// Mic words in whole sentences that closely resemble aligned system words.
function fuzzyEchoMask(
  text: string,
  tokens: Token[],
  offsetMs: number,
  systemWords: TimedWord[],
): boolean[] {
  const n = tokens.length;
  const mask = new Array<boolean>(n).fill(false);
  if (!n || !systemWords.length) return mask;
  for (const m of text.matchAll(SENTENCE)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    const indices: number[] = [];
    tokens.forEach((t, k) => {
      if (t.start >= from && t.start < to) indices.push(k);
    });
    if (indices.length < FUZZY_MIN_WORDS) continue;
    const sentence = indices.map((k) => tokens[k].norm).join(" ");
    if (sentence.length < FUZZY_MIN_CHARS) continue;
    const moment =
      offsetMs +
      (CHUNK_MS * ((indices[0] + indices[indices.length - 1]) / 2 + 0.5)) / n;
    const size = indices.length;
    let best = 0;
    for (
      let length = Math.max(1, size - FUZZY_LENGTH_SLACK);
      length <= size + FUZZY_LENGTH_SLACK;
      length++
    ) {
      for (let start = 0; start + length <= systemWords.length; start++) {
        const run = systemWords.slice(start, start + length);
        const runMoment = (run[0][1] + run[run.length - 1][1]) / 2;
        if (Math.abs(runMoment - moment) > ALIGN_MS) continue;
        best = Math.max(best, ratio(sentence, run.map(([w]) => w).join(" ")));
      }
    }
    if (best >= FUZZY_MIN_RATIO) for (const k of indices) mask[k] = true;
  }
  return mask;
}

/// Which mic tokens repeat the reference (system) shingles. Exported for tests.
export function echoMask(tokens: string[], reference: Set<string>): boolean[] {
  const n = tokens.length;
  const hit = new Array<boolean>(n).fill(false);
  for (let i = 0; i + SHINGLE <= n; i++) {
    if (reference.has(tokens.slice(i, i + SHINGLE).join(" "))) {
      for (let k = i; k < i + SHINGLE; k++) hit[k] = true;
    }
  }

  // Runs of hits, bridging small gaps between them.
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    if (!hit[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && hit[j]) j++;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= MAX_GAP) last[1] = j;
    else runs.push([i, j]);
    i = j;
  }

  const mask = new Array<boolean>(n).fill(false);
  for (const [a, b] of runs) {
    if (b - a < MIN_ECHO_RUN) continue;
    const from = a <= MAX_GAP ? 0 : a;
    const to = n - b <= MAX_GAP ? n : b;
    for (let k = from; k < to; k++) mask[k] = true;
  }
  return mask;
}

/// The mic text without the parts that repeat `reference`, or null when
/// nothing but echo is left.
function stripEcho(
  text: string,
  reference: Set<string>,
  offsetMs = 0,
  systemWords: TimedWord[] = [],
): string | null {
  const tokens = tokenize(text);
  if (tokens.length === 0 || (reference.size === 0 && !systemWords.length)) {
    return text;
  }
  const exact = echoMask(
    tokens.map((t) => t.norm),
    reference,
  );
  const fuzzy = fuzzyEchoMask(text, tokens, offsetMs, systemWords);
  const mask = exact.map((hit, k) => hit || fuzzy[k]);
  if (!mask.some(Boolean)) return text;
  if (mask.every(Boolean)) return null;

  // Keep the original characters (punctuation, casing) of surviving words:
  // each kept run spans from its first word to just before the next removed
  // word.
  const parts: string[] = [];
  let k = 0;
  while (k < tokens.length) {
    if (mask[k]) {
      k++;
      continue;
    }
    let j = k;
    while (j < tokens.length && !mask[j]) j++;
    const end = j < tokens.length ? tokens[j].start : text.length;
    parts.push(text.slice(tokens[k].start, end).trim());
    k = j;
  }
  return parts.join(" … ").replace(/\s+/g, " ").trim();
}

export type EchoFilterResult<T> = {
  chunks: T[];
  /// Mic chunks dropped entirely (only echo).
  removedChunks: number;
  /// Mic chunks kept but shortened.
  trimmedChunks: number;
};

/// Remove from mic chunks what repeats time-overlapping system chunks.
/// System chunks and mic chunks without echo are returned untouched.
export function removeMicEcho<T extends SourcedChunk>(
  chunks: T[],
): EchoFilterResult<T> {
  const system = chunks
    .filter((c) => c.source === "system")
    .map((c) => ({
      at: c.offset_ms,
      words: tokenize(c.text).map((t) => t.norm),
    }));
  if (system.length === 0) {
    return { chunks, removedChunks: 0, trimmedChunks: 0 };
  }

  let removedChunks = 0;
  let trimmedChunks = 0;
  const out: T[] = [];
  for (const c of chunks) {
    if (c.source === "system") {
      out.push(c);
      continue;
    }
    // Mic shingles a nearby system chunk said at about the same moment.
    const heard = new Map<string, number[]>();
    for (const s of system) {
      if (Math.abs(s.at - c.offset_ms) > WINDOW_MS) continue;
      for (const [sh, at] of timedShingles(s.at, s.words)) {
        const times = heard.get(sh);
        if (times) times.push(at);
        else heard.set(sh, [at]);
      }
    }
    const reference = new Set<string>();
    const micWords = tokenize(c.text).map((t) => t.norm);
    for (const [sh, at] of timedShingles(c.offset_ms, micWords)) {
      if (heard.get(sh)?.some((t) => Math.abs(t - at) <= ALIGN_MS)) {
        reference.add(sh);
      }
    }
    const text = stripEcho(
      c.text,
      reference,
      c.offset_ms,
      nearbySystemWords(c.offset_ms, system),
    );
    if (text === null) {
      removedChunks++;
    } else if (text !== c.text) {
      trimmedChunks++;
      out.push({ ...c, text });
    } else {
      out.push(c);
    }
  }
  return { chunks: out, removedChunks, trimmedChunks };
}
