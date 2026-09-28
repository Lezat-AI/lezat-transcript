#!/usr/bin/env bun
/**
 * End-to-end connectivity check for every external service the app talks to.
 *
 * Usage:
 *   bun scripts/e2e-connections.ts
 *
 * Reads credentials from the local app settings store (the same file the app
 * writes after you log in to Cloud Sync / Timesheet), or from the env vars
 * LEZAT_CLOUD_API_KEY / LEZAT_TIMESHEET_TOKEN. Only read-only requests
 * are made, plus one real cloud transcription of a short synthetic clip.
 * Nothing is written to the backend.
 */
import { existsSync, readFileSync, mkdtempSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";

const SETTINGS_PATH = join(
  homedir(),
  "Library/Application Support/co.lezat.transcript/settings_store.json",
);
const DEFAULT_BACKEND =
  "https://founderzat-agent-backend-production.up.railway.app";
const DEFAULT_TIMESHEET = "https://timesheet.back.lezat.tech";
const UPDATER_URL =
  "https://github.com/Lezat-AI/lezat-transcript/releases/latest/download/latest.json";
const MODEL_BLOBS = [
  "https://blob.handy.computer/ggml-small.bin",
  "https://blob.handy.computer/parakeet-v3-int8.tar.gz",
  "https://blob.handy.computer/silero_vad_v4.onnx",
];

type Status = "ok" | "fail" | "skip";
const results: {
  group: string;
  name: string;
  status: Status;
  detail: string;
}[] = [];

function record(group: string, name: string, status: Status, detail = "") {
  results.push({ group, name, status, detail });
  const icon = status === "ok" ? "✅" : status === "fail" ? "❌" : "⏭️ ";
  console.log(`${icon} [${group}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(
  group: string,
  name: string,
  url: string,
  init: RequestInit & { expect?: number[] } = {},
): Promise<Response | null> {
  const expect = init.expect ?? [200];
  const t = performance.now();
  try {
    const res = await fetch(url, {
      redirect: "manual",
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Math.round(performance.now() - t);
    const ok = expect.includes(res.status);
    record(group, name, ok ? "ok" : "fail", `HTTP ${res.status} (${ms}ms)`);
    return res;
  } catch (e) {
    record(group, name, "fail", String(e));
    return null;
  }
}

function loadSettings(): Record<string, unknown> {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  return raw.settings ?? raw;
}

async function makeTestClip(): Promise<{
  path: string;
  phrase: string;
} | null> {
  if (process.platform !== "darwin") return null;
  const phrase =
    "Hola equipo, la reunión de planeación es el martes a las diez de la mañana.";
  const dir = mkdtempSync(join(tmpdir(), "lezat-e2e-"));
  const aiff = join(dir, "clip.aiff");
  const wav = join(dir, "clip.wav");
  try {
    await $`say -v Paulina ${phrase} -o ${aiff}`.quiet();
    await $`afconvert -f WAVE -d LEI16@16000 ${aiff} ${wav}`.quiet();
    return { path: wav, phrase };
  } catch {
    return null;
  }
}

async function main() {
  const s = loadSettings();
  const backend = ((s.cloud_sync_url as string) || DEFAULT_BACKEND).replace(
    /\/$/,
    "",
  );
  const apiKey =
    process.env.LEZAT_CLOUD_API_KEY ||
    (s.cloud_sync_api_key as string | undefined);
  const timesheet = ((s.timesheet_url as string) || DEFAULT_TIMESHEET).replace(
    /\/$/,
    "",
  );
  const tsToken =
    process.env.LEZAT_TIMESHEET_TOKEN ||
    (s.timesheet_token as string | undefined);

  console.log(
    `\nSettings: ${existsSync(SETTINGS_PATH) ? SETTINGS_PATH : "(not found)"}`,
  );
  console.log(`Backend:   ${backend}`);
  console.log(`Timesheet: ${timesheet}\n`);

  // ── Public reachability ─────────────────────────────────────────────
  await check("backend", "GET /api/health", `${backend}/api/health`);
  await check(
    "backend",
    "POST /api/desktop/transcribe rejects no key",
    `${backend}/api/desktop/transcribe`,
    {
      method: "POST",
      expect: [401],
    },
  );
  const g = await check(
    "backend",
    "Google OAuth start redirects",
    `${backend}/api/auth/google/start?redirect_uri=http://localhost:1/callback`,
    {
      expect: [302, 307],
    },
  );
  if (
    g &&
    !g.headers.get("location")?.startsWith("https://accounts.google.com/")
  )
    record(
      "backend",
      "Google OAuth target",
      "fail",
      g.headers.get("location") ?? "no location",
    );

  await check("timesheet", "GET /", `${timesheet}/`);
  await check(
    "timesheet",
    "GET /auth/me rejects no token",
    `${timesheet}/auth/me`,
    { expect: [401, 403] },
  );

  const up = await check("updater", "latest.json", UPDATER_URL, {
    redirect: "follow",
  });
  if (up?.ok) {
    const j = await up.json();
    const local = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../src-tauri/tauri.conf.json"),
        "utf8",
      ),
    ).version;
    const plats = Object.keys(j.platforms ?? {});
    record(
      "updater",
      "published version",
      "ok",
      `${j.version} (local ${local}), platforms: ${plats.join(", ")}`,
    );
  }

  for (const url of MODEL_BLOBS)
    await check("models", url.split("/").pop()!, url, {
      method: "HEAD",
      redirect: "follow",
    });

  // ── Authenticated: Cloud Sync backend ───────────────────────────────
  if (!apiKey) {
    record(
      "backend-auth",
      "authenticated checks",
      "skip",
      "no cloud_sync_api_key — log in to Cloud Sync in the app first",
    );
  } else {
    const H = { "X-API-Key": apiKey };
    const h = await check(
      "backend-auth",
      "GET /api/desktop/health",
      `${backend}/api/desktop/health`,
      { headers: H },
    );
    if (h?.ok) {
      const body = (await h.json()) as { status: string; user_email?: string };
      record(
        "backend-auth",
        "user",
        "ok",
        `${body.user_email ?? "?"} (status=${body.status})`,
      );
    }
    for (const p of [
      "transcriptions",
      "action-items",
      "daily-reports",
      "integrations/status",
    ])
      await check(
        "backend-auth",
        `GET /api/desktop/${p}`,
        `${backend}/api/desktop/${p}`,
        { headers: H },
      );

    const clip = await makeTestClip();
    if (!clip) {
      record(
        "backend-auth",
        "cloud transcription (Gemini)",
        "skip",
        "could not synthesize test clip (macOS only)",
      );
    } else {
      const form = new FormData();
      form.append(
        "file",
        new Blob([readFileSync(clip.path)], { type: "audio/wav" }),
        "audio.wav",
      );
      form.append("language", "es");
      const t = performance.now();
      try {
        const res = await fetch(`${backend}/api/desktop/transcribe`, {
          method: "POST",
          headers: H,
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
        const ms = Math.round(performance.now() - t);
        if (!res.ok) {
          record(
            "backend-auth",
            "cloud transcription (Gemini)",
            "fail",
            `HTTP ${res.status} (${ms}ms): ${(await res.text()).slice(0, 300)}`,
          );
        } else {
          const body = (await res.json()) as { text: string };
          const good =
            /reuni[oó]n/i.test(body.text) && /martes/i.test(body.text);
          record(
            "backend-auth",
            "cloud transcription (Gemini)",
            good ? "ok" : "fail",
            `${ms}ms → "${body.text.trim()}"`,
          );
        }
      } catch (e) {
        record(
          "backend-auth",
          "cloud transcription (Gemini)",
          "fail",
          String(e),
        );
      }
    }
  }

  // ── Authenticated: Timesheet ────────────────────────────────────────
  if (!tsToken) {
    record(
      "timesheet-auth",
      "authenticated checks",
      "skip",
      "no timesheet_token — log in to Timesheet in the app first",
    );
  } else {
    const H = { Authorization: `Bearer ${tsToken}` };
    await check("timesheet-auth", "GET /auth/me", `${timesheet}/auth/me`, {
      headers: H,
    });
    await check("timesheet-auth", "GET /projects/", `${timesheet}/projects/`, {
      headers: H,
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────
  const count = (st: Status) => results.filter((r) => r.status === st).length;
  console.log(
    `\n${count("ok")} ok · ${count("fail")} failed · ${count("skip")} skipped`,
  );
  process.exit(count("fail") > 0 ? 1 : 0);
}

main();
