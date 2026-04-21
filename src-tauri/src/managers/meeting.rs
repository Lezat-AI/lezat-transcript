//! Meeting Mode — long-form, dual-source transcription.
//!
//! Unlike the push-to-talk dictation flow (`AudioRecordingManager` +
//! `TranscribeAction`), meetings:
//!   * run for 30-60 min continuously
//!   * keep the transcription model hot for the whole session
//!   * stream transcript chunks to the frontend as they become available
//!   * persist to the `meetings` table on stop
//!
//! This first cut is **mic-only**. System-audio capture (WASAPI loopback on
//! Windows, ScreenCaptureKit/BlackHole on macOS) lands in a follow-up.

use anyhow::{anyhow, Result};
use chrono::{DateTime, Local, Utc};
use log::{debug, error, info, warn};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::audio_toolkit::system_audio::{resolve_system_audio_device, SystemAudioStatus};
use crate::audio_toolkit::{list_input_devices, AudioRecorder};
use crate::managers::transcription::TranscriptionManager;
use crate::portable;
use crate::settings::get_settings;

/// How much audio we buffer before handing it to Whisper.
/// Shorter → snappier live transcript but smaller context per chunk.
/// Longer → better Whisper accuracy but more perceived lag.
const CHUNK_SECONDS: u64 = 12;

/// Micro-sleep between stop+start during a chunk rollover. Too short and cpal
/// may race; too long and we drop perceptible audio across boundaries.
const CHUNK_ROLLOVER_PAUSE: Duration = Duration::from_millis(30);

// ─────────────────────────────── types ───────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingChunk {
    /// ms offset from meeting start
    pub offset_ms: u64,
    /// "mic" or "system" (second reserved for dual-stream work)
    pub source: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingRecord {
    pub id: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub title: String,
    pub duration_ms: i64,
    pub transcript_text: String,
    pub chunks: Vec<MeetingChunk>,
    pub audio_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct MeetingTranscriptChunkEvent {
    pub meeting_id: i64,
    pub chunk: MeetingChunk,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(tag = "state")]
pub enum MeetingStateEvent {
    #[serde(rename = "started")]
    Started { meeting_id: i64, title: String },
    #[serde(rename = "stopped")]
    Stopped { meeting_id: i64 },
    #[serde(rename = "error")]
    Error { meeting_id: Option<i64>, message: String },
}

// ─────────────────────────────── store ───────────────────────────────

/// Thin DB layer over the `meetings` table. Shares the same `history.db`
/// the dictation flow uses — one file, two logical tables.
pub struct MeetingsStore {
    db_path: PathBuf,
}

impl MeetingsStore {
    pub fn new(app: &AppHandle) -> Result<Self> {
        let app_data_dir = portable::app_data_dir(app)?;
        Ok(Self {
            db_path: app_data_dir.join("history.db"),
        })
    }

    fn conn(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRecord> {
        let chunks_json: String = row.get("chunks_json")?;
        let chunks = serde_json::from_str::<Vec<MeetingChunk>>(&chunks_json).unwrap_or_default();
        Ok(MeetingRecord {
            id: row.get("id")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            title: row.get("title")?,
            duration_ms: row.get("duration_ms")?,
            transcript_text: row.get("transcript_text")?,
            chunks,
            audio_path: row.get("audio_path")?,
        })
    }

    pub fn insert(&self, title: &str, started_at: i64) -> Result<i64> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO meetings (started_at, title, duration_ms, transcript_text, chunks_json)
             VALUES (?1, ?2, 0, '', '[]')",
            params![started_at, title],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn append_chunk(&self, meeting_id: i64, chunk: &MeetingChunk) -> Result<()> {
        let conn = self.conn()?;
        // Read-modify-write on chunks_json. Not great for concurrency but the
        // MeetingManager serialises chunk writes, so this is fine in practice.
        let (chunks_json, transcript_text): (String, String) = conn.query_row(
            "SELECT chunks_json, transcript_text FROM meetings WHERE id = ?1",
            params![meeting_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let mut chunks: Vec<MeetingChunk> =
            serde_json::from_str(&chunks_json).unwrap_or_default();
        chunks.push(chunk.clone());

        let new_text = if transcript_text.is_empty() {
            chunk.text.clone()
        } else {
            format!("{transcript_text} {}", chunk.text)
        };

        conn.execute(
            "UPDATE meetings SET chunks_json = ?1, transcript_text = ?2 WHERE id = ?3",
            params![serde_json::to_string(&chunks)?, new_text, meeting_id],
        )?;
        Ok(())
    }

    pub fn finalize(&self, meeting_id: i64, ended_at: i64, duration_ms: i64) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meetings SET ended_at = ?1, duration_ms = ?2 WHERE id = ?3",
            params![ended_at, duration_ms, meeting_id],
        )?;
        Ok(())
    }

    pub fn list(&self, limit: usize) -> Result<Vec<MeetingRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, started_at, ended_at, title, duration_ms, transcript_text, chunks_json, audio_path
             FROM meetings
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get(&self, id: i64) -> Result<Option<MeetingRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, started_at, ended_at, title, duration_ms, transcript_text, chunks_json, audio_path
             FROM meetings WHERE id = ?1",
        )?;
        let entry = stmt.query_row(params![id], Self::map_row).optional()?;
        Ok(entry)
    }

    pub fn delete(&self, id: i64) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        Ok(())
    }
}

// ────────────────────────────── manager ──────────────────────────────

/// Shared state that the recorder/transcriber threads read.
struct ActiveMeeting {
    id: i64,
    started: Instant,
    stop_flag: Arc<AtomicBool>,
    /// One thread per capture source (mic, optionally system audio).
    handles: Vec<JoinHandle<()>>,
}

pub struct MeetingManager {
    app: AppHandle,
    store: Arc<MeetingsStore>,
    active: Arc<Mutex<Option<ActiveMeeting>>>,
}

impl MeetingManager {
    pub fn new(app: &AppHandle) -> Result<Self> {
        Ok(Self {
            app: app.clone(),
            store: Arc::new(MeetingsStore::new(app)?),
        active: Arc::new(Mutex::new(None)),
        })
    }

    pub fn store(&self) -> Arc<MeetingsStore> {
        self.store.clone()
    }

    pub fn active_meeting_id(&self) -> Option<i64> {
        self.active.lock().unwrap().as_ref().map(|a| a.id)
    }

    /// Start a new meeting. Returns the meeting_id.
    pub fn start(&self, title: Option<String>) -> Result<i64> {
        let mut slot = self.active.lock().unwrap();
        if let Some(active) = slot.as_ref() {
            return Err(anyhow!("Meeting already in progress (id={})", active.id));
        }

        let settings = get_settings(&self.app);
        let started_at = Utc::now().timestamp();
        let title = title.unwrap_or_else(|| default_title(started_at));
        let id = self.store.insert(&title, started_at)?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::new();

        // Always spawn the microphone loop.
        let mic_device = resolve_mic_device(&settings);
        handles.push(spawn_recording_loop(
            self.app.clone(),
            self.store.clone(),
            id,
            stop_flag.clone(),
            "mic".to_string(),
            mic_device,
        )?);

        // Optionally spawn the system-audio loop.
        if settings.capture_system_audio {
            match resolve_system_audio_device() {
                SystemAudioStatus::Available { device, label } => {
                    info!(
                        "Meeting {id}: capturing system audio via '{label}'"
                    );
                    handles.push(spawn_recording_loop(
                        self.app.clone(),
                        self.store.clone(),
                        id,
                        stop_flag.clone(),
                        "system".to_string(),
                        Some(device),
                    )?);
                }
                SystemAudioStatus::NotConfigured { install_hint } => {
                    warn!(
                        "Meeting {id}: system-audio requested but not configured — {install_hint}"
                    );
                    let _ = (MeetingStateEvent::Error {
                        meeting_id: Some(id),
                        message: format!(
                            "System audio is enabled but not set up: {install_hint}"
                        ),
                    })
                    .emit(&self.app);
                }
                SystemAudioStatus::NotYetSupported { message } => {
                    warn!("Meeting {id}: system-audio not supported — {message}");
                    let _ = (MeetingStateEvent::Error {
                        meeting_id: Some(id),
                        message,
                    })
                    .emit(&self.app);
                }
            }
        }

        *slot = Some(ActiveMeeting {
            id,
            started: Instant::now(),
            stop_flag,
            handles,
        });

        let _ = (MeetingStateEvent::Started {
            meeting_id: id,
            title,
        })
        .emit(&self.app);

        Ok(id)
    }

    /// Stop the active meeting. Returns the finalized record.
    pub fn stop(&self) -> Result<MeetingRecord> {
        let mut slot = self.active.lock().unwrap();
        let active = slot
            .take()
            .ok_or_else(|| anyhow!("No meeting in progress"))?;

        active.stop_flag.store(true, Ordering::SeqCst);
        // Release the lock before join so a racing start() gets a fresh `None`.
        drop(slot);

        for h in active.handles {
            let _ = h.join();
        }

        let duration_ms = active.started.elapsed().as_millis() as i64;
        let ended_at = Utc::now().timestamp();
        self.store.finalize(active.id, ended_at, duration_ms)?;

        let _ = (MeetingStateEvent::Stopped {
            meeting_id: active.id,
        })
        .emit(&self.app);

        self.store
            .get(active.id)?
            .ok_or_else(|| anyhow!("Meeting {} missing after finalize", active.id))
    }
}

/// Resolve the mic device from settings, or default to cpal's default input.
fn resolve_mic_device(settings: &crate::settings::AppSettings) -> Option<cpal::Device> {
    settings
        .selected_microphone
        .as_ref()
        .and_then(|name| {
            list_input_devices()
                .ok()?
                .into_iter()
                .find(|d| d.name == *name)
                .map(|d| d.device)
        })
}

fn default_title(timestamp: i64) -> String {
    if let Some(dt) = DateTime::from_timestamp(timestamp, 0) {
        dt.with_timezone(&Local)
            .format("Meeting — %B %e, %Y %l:%M%p")
            .to_string()
    } else {
        format!("Meeting {timestamp}")
    }
}

// ──────────────────────────── recording loop ────────────────────────────

/// Spawns a background thread that drives ONE capture source. Returns the
/// thread handle so the caller can join on stop. A meeting can have one or
/// two of these running in parallel (mic always, system audio optional).
fn spawn_recording_loop(
    app: AppHandle,
    store: Arc<MeetingsStore>,
    meeting_id: i64,
    stop_flag: Arc<AtomicBool>,
    source: String,
    device: Option<cpal::Device>,
) -> Result<JoinHandle<()>> {
    let handle = thread::Builder::new()
        .name(format!("meeting-{meeting_id}-{source}"))
        .spawn(move || {
            if let Err(e) =
                run_recording_loop(&app, &store, meeting_id, &stop_flag, &source, device)
            {
                error!(
                    "Meeting {meeting_id} [{source}] recording loop failed: {e}"
                );
                let _ = (MeetingStateEvent::Error {
                    meeting_id: Some(meeting_id),
                    message: format!("{source}: {e}"),
                })
                .emit(&app);
            }
        })?;
    Ok(handle)
}

fn run_recording_loop(
    app: &AppHandle,
    store: &Arc<MeetingsStore>,
    meeting_id: i64,
    stop_flag: &Arc<AtomicBool>,
    source: &str,
    device: Option<cpal::Device>,
) -> Result<()> {
    let mut recorder = AudioRecorder::new()
        .map_err(|e| anyhow!("AudioRecorder::new failed: {e}"))?;
    recorder
        .open(device)
        .map_err(|e| anyhow!("Recorder open failed: {e}"))?;

    info!("Meeting {meeting_id} [{source}]: recorder opened, starting capture loop");

    let chunk_start = Instant::now();
    let mut offset_ms_at_chunk_start: u64 = 0;

    while !stop_flag.load(Ordering::SeqCst) {
        // Begin a new chunk window.
        if let Err(e) = recorder.start() {
            warn!("recorder.start failed: {e}");
            thread::sleep(Duration::from_millis(200));
            continue;
        }

        // Sleep until it's time to roll over (or until stop is requested).
        let deadline = Instant::now() + Duration::from_secs(CHUNK_SECONDS);
        while Instant::now() < deadline && !stop_flag.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
        }

        // Drain this chunk's samples.
        let samples = match recorder.stop() {
            Ok(s) => s,
            Err(e) => {
                warn!("recorder.stop failed: {e}");
                thread::sleep(Duration::from_millis(200));
                continue;
            }
        };

        let this_chunk_offset_ms = offset_ms_at_chunk_start;
        offset_ms_at_chunk_start = chunk_start.elapsed().as_millis() as u64;

        // Short chunk (<400ms) is almost always start/stop overhead, skip it.
        if samples.len() < 16_000 / 3 {
            debug!(
                "Meeting {meeting_id} [{source}]: skipping tiny chunk ({} samples)",
                samples.len()
            );
            if !stop_flag.load(Ordering::SeqCst) {
                thread::sleep(CHUNK_ROLLOVER_PAUSE);
            }
            continue;
        }

        // Transcribe on THIS thread (one chunk at a time per source). The
        // TranscriptionManager serialises internally — when two meeting
        // threads call it concurrently they queue on its mutex. That's
        // intentional: running the Whisper engine in two parallel lanes
        // would double the GPU/CPU load and OOM on low-end hardware.
        let transcription_manager = match app.try_state::<Arc<TranscriptionManager>>() {
            Some(tm) => tm.inner().clone(),
            None => {
                warn!("TranscriptionManager not yet registered; skipping chunk");
                continue;
            }
        };

        match transcription_manager.transcribe(samples) {
            Ok(text) => {
                let cleaned = text.trim().to_string();
                if !cleaned.is_empty() {
                    let chunk = MeetingChunk {
                        offset_ms: this_chunk_offset_ms,
                        source: source.to_string(),
                        text: cleaned,
                    };
                    if let Err(e) = store.append_chunk(meeting_id, &chunk) {
                        error!("Failed to persist chunk: {e}");
                    }
                    let _ = (MeetingTranscriptChunkEvent {
                        meeting_id,
                        chunk,
                    })
                    .emit(app);
                }
            }
            Err(e) => {
                error!("Transcription failed for meeting {meeting_id} [{source}]: {e}");
            }
        }

        if !stop_flag.load(Ordering::SeqCst) {
            thread::sleep(CHUNK_ROLLOVER_PAUSE);
        }
    }

    let _ = recorder.close();
    info!("Meeting {meeting_id} [{source}]: recording loop exited cleanly");
    Ok(())
}
