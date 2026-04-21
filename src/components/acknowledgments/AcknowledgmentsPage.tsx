import React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";

type Acknowledgment = {
  name: string;
  blurb: string;
  url?: string;
};

const ITEMS: Acknowledgment[] = [
  {
    name: "Handy",
    blurb:
      "Lezat Transcript is a fork of Handy by CJ Pais. The app shell, push-to-talk flow, transcription orchestration, and much of the Tauri scaffolding come straight from upstream. Thank you for the MIT license and the clean codebase.",
    url: "https://github.com/cjpais/Handy",
  },
  {
    name: "Whisper by OpenAI",
    blurb: "The speech-recognition model that does the actual transcribing.",
    url: "https://github.com/openai/whisper",
  },
  {
    name: "whisper.cpp and ggml",
    blurb:
      "Amazing cross-platform Whisper inference and acceleration — the reason this runs locally on every laptop instead of calling a cloud.",
    url: "https://github.com/ggerganov/whisper.cpp",
  },
  {
    name: "Silero VAD",
    blurb:
      "Great lightweight voice-activity detection — gates silence efficiently without CPU cost.",
    url: "https://github.com/snakers4/silero-vad",
  },
  {
    name: "Tauri",
    blurb:
      "The excellent Rust-based desktop app framework that keeps the bundle small and the UI native-feeling across macOS, Windows, and Linux.",
    url: "https://tauri.app",
  },
  {
    name: "Community contributors",
    blurb:
      "Everyone who has helped make Handy (and by extension Lezat Transcript) better — bug reports, translations, PRs, docs, and feedback.",
  },
];

export function AcknowledgmentsPage() {
  return (
    <div className="w-full max-w-3xl flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">Acknowledgments</h2>
        <p className="text-sm text-mid-gray leading-relaxed">
          Lezat Transcript stands on a lot of shoulders. Below are the projects
          and people without whom this would not exist.
        </p>
      </header>

      <ul className="flex flex-col divide-y divide-mid-gray/15 rounded-xl border border-mid-gray/20 overflow-hidden">
        {ITEMS.map((item) => (
          <li key={item.name} className="p-5 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-sm font-bold">{item.name}</h3>
              {item.url && (
                <button
                  onClick={() => openUrl(item.url!)}
                  className="text-xs text-mid-gray hover:text-foreground inline-flex items-center gap-1 shrink-0"
                  title={item.url}
                >
                  Open
                  <ExternalLink className="w-3 h-3" />
                </button>
              )}
            </div>
            <p className="text-sm text-mid-gray leading-relaxed">
              {item.blurb}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default AcknowledgmentsPage;
