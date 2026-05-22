/* eslint-disable i18next/no-literal-string */
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
      "Lezat Transcript es un fork de Handy por CJ Pais. La estructura de la app, el flujo de presionar para hablar, la orquestación de transcripción y gran parte del scaffolding de Tauri provienen directamente del proyecto original. Gracias por la licencia MIT y el código limpio.",
    url: "https://github.com/cjpais/Handy",
  },
  {
    name: "Whisper de OpenAI",
    blurb: "El modelo de reconocimiento de voz que realiza la transcripción.",
    url: "https://github.com/openai/whisper",
  },
  {
    name: "whisper.cpp y ggml",
    blurb:
      "Increíble inferencia multiplataforma de Whisper con aceleración — la razón por la que esto funciona localmente en cada laptop en vez de llamar a la nube.",
    url: "https://github.com/ggerganov/whisper.cpp",
  },
  {
    name: "Silero VAD",
    blurb:
      "Detección de actividad de voz ligera y eficiente — filtra el silencio sin costo de CPU.",
    url: "https://github.com/snakers4/silero-vad",
  },
  {
    name: "Tauri",
    blurb:
      "El excelente framework de aplicaciones de escritorio basado en Rust que mantiene el paquete pequeño y la interfaz nativa en macOS, Windows y Linux.",
    url: "https://tauri.app",
  },
  {
    name: "Colaboradores de la comunidad",
    blurb:
      "Todos los que han ayudado a mejorar Handy (y por extensión Lezat Transcript) — reportes de bugs, traducciones, PRs, documentación y retroalimentación.",
  },
];

export function AcknowledgmentsPage() {
  return (
    <div className="w-full max-w-3xl flex flex-col gap-6">
      <header className="flex flex-col gap-2">
<h2 className="text-lg font-bold">Reconocimientos</h2>
<p className="text-sm text-mid-gray leading-relaxed">
          Lezat Transcript se apoya en muchos hombros. A continuación están los
          proyectos y personas sin los cuales esto no existiría.
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
                  Abrir
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
