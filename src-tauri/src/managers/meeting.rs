//! Meeting Mode — long-form, dual-source transcription.
//!
//! Unlike the push-to-talk dictation flow (`AudioRecordingManager` +
//! `TranscribeAction`), meetings:
//!   * run for 30-60 min continuously
//!   * keep the transcription model hot for the whole session
//!   * stream transcript chunks to the frontend as they become available
//!   * persist to the `meetings` table on stop
//!
//! The mic is always captured via cpal. System audio (the other side of a
//! call) may come from either:
//!   * cpal — macOS BlackHole / Linux PulseAudio monitor source
//!   * WASAPI loopback — Windows default render endpoint (zero install)
//! See `audio_toolkit::system_audio` for source resolution.

use anyhow::{anyhow, Result};
use chrono::{DateTime, Local, Utc};
use log::{debug, error, info, warn};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use hound::{SampleFormat, WavSpec, WavWriter};
use std::fs;

#[cfg(target_os = "macos")]
use crate::audio_toolkit::macos_native_audio::MacosNativeAudioRecorder;
use crate::audio_toolkit::system_audio::{
    resolve_system_audio_device, SystemAudioSource, SystemAudioStatus,
};
#[cfg(target_os = "windows")]
use crate::audio_toolkit::wasapi_loopback::WasapiLoopbackRecorder;
use crate::audio_toolkit::{list_input_devices, AudioRecorder, SileroVad, VoiceActivityDetector};
use crate::managers::transcription::TranscriptionManager;
use crate::portable;
use crate::settings::get_settings;

/// Minimum fraction of 30-ms frames that must contain speech for a chunk to be
/// worth transcribing.  Chunks below this are almost certainly silence/noise
/// and would only produce Whisper hallucinations.
const MIN_SPEECH_RATIO: f32 = 0.05;

/// Frame size for Silero VAD: 30 ms at 16 kHz = 480 samples.
const VAD_FRAME_SAMPLES: usize = 480;

/// A per-source capture backend. Unified `start/stop/close` surface so the
/// meeting recording loop doesn't care whether samples come from cpal or
/// WASAPI.
enum SourceCapture {
    Cpal(AudioRecorder),
    #[cfg(target_os = "windows")]
    Wasapi(WasapiLoopbackRecorder),
    #[cfg(target_os = "macos")]
    MacosNative(MacosNativeAudioRecorder),
}

impl SourceCapture {
    fn start(&self) -> std::result::Result<(), Box<dyn std::error::Error>> {
        match self {
            SourceCapture::Cpal(r) => r.start(),
            #[cfg(target_os = "windows")]
            SourceCapture::Wasapi(r) => r.start().map_err(|e| e.into()),
            #[cfg(target_os = "macos")]
            SourceCapture::MacosNative(r) => r.start().map_err(|e| e.into()),
        }
    }

    fn stop(&self) -> std::result::Result<Vec<f32>, Box<dyn std::error::Error>> {
        match self {
            SourceCapture::Cpal(r) => r.stop(),
            #[cfg(target_os = "windows")]
            SourceCapture::Wasapi(r) => r.stop().map_err(|e| e.into()),
            #[cfg(target_os = "macos")]
            SourceCapture::MacosNative(r) => r.stop().map_err(|e| e.into()),
        }
    }

    fn drain(&self) -> std::result::Result<Vec<f32>, Box<dyn std::error::Error>> {
        match self {
            SourceCapture::Cpal(r) => r.drain(),
            #[cfg(target_os = "windows")]
            SourceCapture::Wasapi(r) => r.drain().map_err(|e| e.into()),
            #[cfg(target_os = "macos")]
            SourceCapture::MacosNative(r) => r.drain().map_err(|e| e.into()),
        }
    }

    fn close(&mut self) -> std::result::Result<(), Box<dyn std::error::Error>> {
        match self {
            SourceCapture::Cpal(r) => r.close(),
            #[cfg(target_os = "windows")]
            SourceCapture::Wasapi(r) => r.close().map_err(|e| e.into()),
            #[cfg(target_os = "macos")]
            SourceCapture::MacosNative(r) => r.close().map_err(|e| e.into()),
        }
    }
}

fn open_cpal(device: Option<cpal::Device>) -> Result<SourceCapture> {
    let mut r = AudioRecorder::new().map_err(|e| anyhow!("AudioRecorder::new failed: {e}"))?;
    r.open(device)
        .map_err(|e| anyhow!("Recorder open failed: {e}"))?;
    Ok(SourceCapture::Cpal(r))
}

#[cfg(target_os = "windows")]
fn open_wasapi() -> Result<SourceCapture> {
    let mut r = WasapiLoopbackRecorder::new()?;
    r.open(None)?;
    Ok(SourceCapture::Wasapi(r))
}

#[cfg(target_os = "macos")]
fn open_macos_native() -> Result<SourceCapture> {
    let mut r = MacosNativeAudioRecorder::new()?;
    r.open(None)?;
    Ok(SourceCapture::MacosNative(r))
}

const SAMPLE_RATE: usize = 16_000;

/// Chunks are cut at the first pause after this much audio. Shorter →
/// snappier live transcript but less context per chunk.
const CHUNK_MIN_SECONDS: usize = 12;

/// Hard cut when nobody pauses for this long.
const CHUNK_MAX_SECONDS: usize = 20;

/// A pause long enough to cut at (in 30-ms VAD frames): ~300 ms.
const CUT_SILENCE_FRAMES: usize = 10;

/// How often the capture loop collects new samples and checks for a cut.
const DRAIN_INTERVAL: Duration = Duration::from_millis(250);

/// A source whose samples arrive this much later than the audio already
/// pending (e.g. system audio while nothing plays: some backends deliver no
/// samples at all) has a hole in its timeline.
const GAP_TOLERANCE_MS: u64 = 1_000;

/// Holes up to this long are filled with silence so the pending audio keeps
/// its wall-clock position; longer ones end the pending chunk instead.
const GAP_PAD_MAX_MS: u64 = CHUNK_MAX_SECONDS as u64 * 1_000;

/// After this many VAD errors in a row the source stops using the VAD and
/// classifies frames by energy instead.
const VAD_MAX_CONSECUTIVE_ERRORS: u32 = 10;

/// Frame RMS above which the energy fallback counts a frame as speech
/// (about -40 dBFS).
const ENERGY_SPEECH_RMS: f32 = 0.01;

/// How often the default output device is sampled during a meeting.
const OUTPUT_PROBE_INTERVAL: Duration = Duration::from_secs(60);

/// Who set a meeting's participants.
pub const PARTICIPANTS_SOURCE_USER: &str = "user";
pub const PARTICIPANTS_SOURCE_CALENDAR: &str = "calendar";

/// Upload state of a meeting (`sync_state` column).
pub const SYNC_PENDING: &str = "pending";
pub const SYNC_FAILED: &str = "failed";
pub const SYNC_SYNCED: &str = "synced";

/// Automatic upload retries: first check after start-up, then this often.
const RETRY_FIRST_CHECK: Duration = Duration::from_secs(30);
const RETRY_CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// Wait before retry n (n ≥ 1): 5 min, doubling, at most 6 h.
const RETRY_BASE_SECS: i64 = 5 * 60;
const RETRY_MAX_SECS: i64 = 6 * 60 * 60;
/// After this many attempts only a manual sync uploads the meeting.
const RETRY_MAX_ATTEMPTS: u32 = 12;

// ─────────────────────────────── types ───────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingChunk {
    /// ms offset from meeting start
    pub offset_ms: u64,
    /// "mic" or "system" (second reserved for dual-stream work)
    pub source: String,
    pub text: String,
    /// Audio length of the chunk in ms (12–20 s, cut at pauses). Missing on
    /// recordings made before it was tracked.
    #[serde(default)]
    pub duration_ms: Option<u64>,
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
    #[serde(default)]
    pub is_daily: bool,
    /// Calendar event the recording was matched to, if any.
    #[serde(default)]
    pub calendar_event_id: Option<String>,
    #[serde(default)]
    pub calendar_event_title: Option<String>,
    /// Attendees: detected from the calendar and/or edited by the user.
    #[serde(default)]
    pub participants: Vec<MeetingParticipant>,
    /// Who set `participants`: "calendar", "user", or nobody yet. An empty
    /// list set by the user means they removed everyone on purpose.
    #[serde(default)]
    pub participants_source: Option<String>,
    /// Upload state: "pending" | "failed" | "synced". `None` for meetings
    /// recorded without cloud sync or before this was tracked.
    #[serde(default)]
    pub sync_state: Option<String>,
}

/// One meeting attendee. Names added by hand have no email.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MeetingParticipant {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
}

/// Emitted once the calendar lookup for a meeting finishes.
#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct MeetingCalendarContextEvent {
    pub meeting_id: i64,
    pub calendar_event_id: Option<String>,
    pub calendar_event_title: Option<String>,
    pub participants: Vec<MeetingParticipant>,
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
    Error {
        meeting_id: Option<i64>,
        message: String,
    },
}

// ─────────────────────────────── store ───────────────────────────────

/// Thin DB layer over the `meetings` table. Shares the same `history.db`
/// the dictation flow uses — one file, two logical tables.
pub struct MeetingsStore {
    db_path: PathBuf,
    /// Set once the optional columns below are known to exist.
    schema_ready: AtomicBool,
}

/// Columns added after the `meetings` table shipped. Added ad hoc (not via
/// the history migrations) because `is_daily` already was, and a migration
/// re-adding it would fail on existing databases.
const OPTIONAL_COLUMNS: &[(&str, &str)] = &[
    ("is_daily", "INTEGER NOT NULL DEFAULT 0"),
    ("calendar_event_id", "TEXT"),
    ("calendar_event_title", "TEXT"),
    ("participants_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("participants_source", "TEXT"),
    ("sync_state", "TEXT"),
    ("sync_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("last_sync_attempt_at", "INTEGER"),
    ("client_diagnostics_json", "TEXT"),
];

const MEETING_COLUMNS: &str = "id, started_at, ended_at, title, duration_ms, transcript_text, \
     chunks_json, audio_path, is_daily, calendar_event_id, calendar_event_title, participants_json, \
     participants_source, sync_state";

/// A meeting waiting for an automatic upload retry.
#[derive(Debug, Clone)]
pub struct SyncCandidate {
    pub id: i64,
    pub attempts: u32,
    pub last_attempt_at: Option<i64>,
}

impl MeetingsStore {
    pub fn new(app: &AppHandle) -> Result<Self> {
        let app_data_dir = portable::app_data_dir(app)?;
        Ok(Self {
            db_path: app_data_dir.join("history.db"),
            schema_ready: AtomicBool::new(false),
        })
    }

    fn conn(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)?;
        if !self.schema_ready.load(Ordering::Relaxed) && Self::ensure_columns(&conn) {
            self.schema_ready.store(true, Ordering::Relaxed);
        }
        Ok(conn)
    }

    /// Adds any missing optional column. Returns false while the `meetings`
    /// table doesn't exist yet (the history migrations create it).
    fn ensure_columns(conn: &Connection) -> bool {
        let existing: Vec<String> = match conn.prepare("PRAGMA table_info(meetings)") {
            Ok(mut stmt) => match stmt.query_map([], |row| row.get::<_, String>(1)) {
                Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                Err(_) => return false,
            },
            Err(_) => return false,
        };
        if existing.is_empty() {
            return false;
        }
        let mut ok = true;
        for (name, decl) in OPTIONAL_COLUMNS {
            if existing.iter().any(|c| c == name) {
                continue;
            }
            if let Err(e) =
                conn.execute_batch(&format!("ALTER TABLE meetings ADD COLUMN {name} {decl};"))
            {
                warn!("Failed to add meetings.{name}: {e}");
                ok = false;
            }
        }
        ok
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
            is_daily: row.get::<_, i64>("is_daily").unwrap_or(0) != 0,
            calendar_event_id: row
                .get::<_, Option<String>>("calendar_event_id")
                .unwrap_or(None),
            calendar_event_title: row
                .get::<_, Option<String>>("calendar_event_title")
                .unwrap_or(None),
            participants: row
                .get::<_, Option<String>>("participants_json")
                .ok()
                .flatten()
                .and_then(|json| serde_json::from_str(&json).ok())
                .unwrap_or_default(),
            participants_source: row
                .get::<_, Option<String>>("participants_source")
                .unwrap_or(None),
            sync_state: row.get::<_, Option<String>>("sync_state").unwrap_or(None),
        })
    }

    /// `sync_state` is `Some("pending")` when the meeting will be uploaded.
    pub fn insert(
        &self,
        title: &str,
        started_at: i64,
        is_daily: bool,
        sync_state: Option<&str>,
    ) -> Result<i64> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO meetings (started_at, title, duration_ms, transcript_text, chunks_json, is_daily, sync_state)
             VALUES (?1, ?2, 0, '', '[]', ?3, ?4)",
            params![started_at, title, is_daily as i64, sync_state],
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

        let mut chunks: Vec<MeetingChunk> = serde_json::from_str(&chunks_json).unwrap_or_default();
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

    /// Prune meetings older than `cutoff_ts` (Unix seconds). Removes both
    /// the DB row and any persisted audio directory on disk. Respects the
    /// same retention policy the dictation history uses; called
    /// opportunistically on meeting finalize.
    pub fn prune_older_than(&self, cutoff_ts: i64) -> Result<usize> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT id, audio_path FROM meetings WHERE started_at < ?1")?;
        let rows: Vec<(i64, Option<String>)> = stmt
            .query_map(params![cutoff_ts], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        let mut pruned = 0usize;
        for (id, audio_path) in rows {
            conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
            if let Some(p) = audio_path {
                let path = std::path::Path::new(&p);
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(path);
                } else if path.is_file() {
                    let _ = std::fs::remove_file(path);
                }
            }
            pruned += 1;
        }
        Ok(pruned)
    }

    pub fn set_audio_path(&self, meeting_id: i64, path: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meetings SET audio_path = ?1 WHERE id = ?2",
            params![path, meeting_id],
        )?;
        Ok(())
    }

    /// Store the calendar match and merge its attendees into the meeting's
    /// (see [`merge_calendar_participants`]), so a late lookup never
    /// clobbers user edits. Returns the participants now stored.
    pub fn set_calendar_context(
        &self,
        meeting_id: i64,
        event_id: &str,
        event_title: Option<&str>,
        detected: &[MeetingParticipant],
    ) -> Result<Vec<MeetingParticipant>> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let (json, source): (Option<String>, Option<String>) = tx.query_row(
            "SELECT participants_json, participants_source FROM meetings WHERE id = ?1",
            params![meeting_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let current: Vec<MeetingParticipant> = json
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        let (next, next_source) =
            merge_calendar_participants(&current, source.as_deref(), detected);
        tx.execute(
            "UPDATE meetings SET calendar_event_id = ?1, calendar_event_title = ?2,
                 participants_json = ?3, participants_source = ?4
             WHERE id = ?5",
            params![
                event_id,
                event_title,
                serde_json::to_string(&next)?,
                next_source,
                meeting_id
            ],
        )?;
        tx.commit()?;
        Ok(next)
    }

    /// User edit: replaces the list and marks it as the user's.
    pub fn set_participants(
        &self,
        meeting_id: i64,
        participants: &[MeetingParticipant],
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meetings SET participants_json = ?1, participants_source = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(participants)?,
                PARTICIPANTS_SOURCE_USER,
                meeting_id
            ],
        )?;
        Ok(())
    }

    pub fn set_sync_state(&self, meeting_id: i64, state: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meetings SET sync_state = ?1 WHERE id = ?2",
            params![state, meeting_id],
        )?;
        Ok(())
    }

    /// Count an upload attempt; returns the attempt number.
    pub fn mark_sync_attempt(&self, meeting_id: i64, at: i64) -> Result<u32> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meetings SET sync_attempts = COALESCE(sync_attempts, 0) + 1,
                 last_sync_attempt_at = ?1
             WHERE id = ?2",
            params![at, meeting_id],
        )?;
        let attempts: i64 = conn.query_row(
            "SELECT COALESCE(sync_attempts, 0) FROM meetings WHERE id = ?1",
            params![meeting_id],
            |row| row.get(0),
        )?;
        Ok(attempts.max(0) as u32)
    }

    /// Finished meetings whose upload is pending or failed, oldest first.
    pub fn sync_candidates(&self) -> Result<Vec<SyncCandidate>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(sync_attempts, 0), last_sync_attempt_at FROM meetings
             WHERE sync_state IN (?1, ?2) AND ended_at IS NOT NULL
             ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![SYNC_PENDING, SYNC_FAILED], |row| {
            Ok(SyncCandidate {
                id: row.get(0)?,
                attempts: row.get::<_, i64>(1)?.max(0) as u32,
                last_attempt_at: row.get(2)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Diagnostics captured when the meeting was recorded, re-sent with
    /// every later upload of it.
    pub fn set_client_diagnostics(
        &self,
        meeting_id: i64,
        diagnostics: &serde_json::Value,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meetings SET client_diagnostics_json = ?1 WHERE id = ?2",
            params![serde_json::to_string(diagnostics)?, meeting_id],
        )?;
        Ok(())
    }

    pub fn client_diagnostics(&self, meeting_id: i64) -> Result<Option<serde_json::Value>> {
        let conn = self.conn()?;
        let json: Option<String> = conn
            .query_row(
                "SELECT client_diagnostics_json FROM meetings WHERE id = ?1",
                params![meeting_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
    }

    pub fn rename(&self, meeting_id: i64, title: &str) -> Result<()> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Meeting title cannot be empty"));
        }
        let conn = self.conn()?;
        conn.execute(
            "UPDATE meetings SET title = ?1 WHERE id = ?2",
            params![trimmed, meeting_id],
        )?;
        Ok(())
    }

    pub fn list(&self, limit: usize) -> Result<Vec<MeetingRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {MEETING_COLUMNS} FROM meetings ORDER BY started_at DESC LIMIT ?1"
        ))?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get(&self, id: i64) -> Result<Option<MeetingRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {MEETING_COLUMNS} FROM meetings WHERE id = ?1"
        ))?;
        let entry = stmt.query_row(params![id], Self::map_row).optional()?;
        Ok(entry)
    }

    pub fn delete(&self, id: i64) -> Result<()> {
        // Fetch audio_path first so we can clean up the directory on disk
        // alongside the database row.
        let audio_path: Option<String> = self
            .conn()?
            .query_row(
                "SELECT audio_path FROM meetings WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let conn = self.conn()?;
        conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;

        if let Some(p) = audio_path {
            let path = std::path::Path::new(&p);
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else if path.is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(())
    }
}

// ────────────────────────────── manager ──────────────────────────────

/// Shared state that the recorder/transcriber threads read.
struct ActiveMeeting {
    id: i64,
    started: Instant,
    stop_flag: Arc<AtomicBool>,
    /// One thread per capture source (mic, optionally system audio), plus
    /// the output-device probe.
    handles: Vec<JoinHandle<()>>,
    /// The calendar lookup started with the recording, joined before the
    /// stop-time lookup so the two can't race.
    calendar_handle: Option<JoinHandle<()>>,
    stats: MeetingStats,
    diag: MeetingDiag,
}

/// What happened to each captured chunk of one source, sent to the backend as
/// content-free diagnostics: without it a hole in the transcript can't be told
/// apart from silence, a failed transcription or an empty result.
#[derive(Debug, Default, Clone, Serialize)]
pub struct SourceStats {
    pub chunks_captured: u32,
    pub audio_seconds: f64,
    pub skipped_tiny: u32,
    pub skipped_silent: u32,
    pub transcribed: u32,
    pub empty_text: u32,
    pub failed: u32,
    /// How pauses are found: "vad", or "energy" when the VAD couldn't be
    /// loaded or kept failing (see `vad_degraded`).
    pub chunking: String,
    pub vad_errors: u32,
    pub vad_degraded: bool,
    /// Chunks cut in a pause vs. forced (no pause before the maximum length).
    pub silence_cuts: u32,
    pub forced_cuts: u32,
    /// Chunks ended early by a long hole in the source's audio.
    pub gap_cuts: u32,
    /// Collecting samples from the capture backend failed.
    pub drain_errors: u32,
    /// Holes in the source's audio (no samples delivered for > 1 s) and
    /// their total length; `padded_ms` of them were filled with silence.
    pub gaps: u32,
    pub gap_ms: u64,
    pub padded_ms: u64,
}

type MeetingStats = Arc<Mutex<BTreeMap<String, SourceStats>>>;

fn record_stat(stats: &MeetingStats, source: &str, update: impl FnOnce(&mut SourceStats)) {
    if let Ok(mut map) = stats.lock() {
        update(map.entry(source.to_string()).or_default());
    }
}

/// Recording-wide diagnostics (calendar lookup, capture backend, output
/// device), merged into `client_diagnostics` on stop.
#[derive(Debug, Default)]
struct MeetingDiagnostics {
    fields: serde_json::Map<String, serde_json::Value>,
    /// How often each output-device kind was seen while recording.
    output_kinds: BTreeMap<String, u32>,
    /// Event matched when the recording started (not sent; only used to
    /// tell whether the stop-time lookup agreed).
    start_event_id: Option<String>,
}

type MeetingDiag = Arc<Mutex<MeetingDiagnostics>>;

fn set_diag(diag: &MeetingDiag, key: &str, value: serde_json::Value) {
    if let Ok(mut d) = diag.lock() {
        d.fields.insert(key.to_string(), value);
    }
}

/// Tracks work that must not be cut by a relaunch (finalizing and uploading
/// stopped meetings) and which meetings are being uploaded right now.
#[derive(Default)]
pub struct SyncTracker {
    busy: AtomicUsize,
    in_flight: Mutex<HashSet<i64>>,
}

/// Held while background meeting work runs; see [`MeetingManager::is_busy`].
pub struct BusyGuard(Arc<SyncTracker>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.busy.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Exclusive right to upload one meeting.
pub struct UploadClaim {
    tracker: Arc<SyncTracker>,
    meeting_id: i64,
}

impl Drop for UploadClaim {
    fn drop(&mut self) {
        if let Ok(mut set) = self.tracker.in_flight.lock() {
            set.remove(&self.meeting_id);
        }
    }
}

impl SyncTracker {
    pub fn busy_guard(self: &Arc<Self>) -> BusyGuard {
        self.busy.fetch_add(1, Ordering::SeqCst);
        BusyGuard(self.clone())
    }

    /// `None` while the meeting is already being uploaded.
    pub fn claim(self: &Arc<Self>, meeting_id: i64) -> Option<UploadClaim> {
        let mut set = self.in_flight.lock().ok()?;
        set.insert(meeting_id).then(|| UploadClaim {
            tracker: self.clone(),
            meeting_id,
        })
    }

    fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst) > 0
    }
}

/// Why a meeting is being uploaded (sent as `upload_kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadKind {
    /// Right after the recording stopped.
    AfterStop,
    /// The background retry of a pending/failed upload.
    AutoRetry,
    /// "Sync to cloud" in the UI: the backend extracts tasks again.
    Manual,
}

impl UploadKind {
    fn as_str(self) -> &'static str {
        match self {
            UploadKind::AfterStop => "after_stop",
            UploadKind::AutoRetry => "auto_retry",
            UploadKind::Manual => "manual",
        }
    }
}

pub struct MeetingManager {
    app: AppHandle,
    store: Arc<MeetingsStore>,
    active: Arc<Mutex<Option<ActiveMeeting>>>,
    sync: Arc<SyncTracker>,
}

impl MeetingManager {
    pub fn new(app: &AppHandle) -> Result<Self> {
        Ok(Self {
            app: app.clone(),
            store: Arc::new(MeetingsStore::new(app)?),
            active: Arc::new(Mutex::new(None)),
            sync: Arc::default(),
        })
    }

    pub fn store(&self) -> Arc<MeetingsStore> {
        self.store.clone()
    }

    pub fn sync_tracker(&self) -> Arc<SyncTracker> {
        self.sync.clone()
    }

    pub fn active_meeting_id(&self) -> Option<i64> {
        self.active.lock().unwrap().as_ref().map(|a| a.id)
    }

    /// True while a meeting records or a stopped one is still being
    /// finalized, transcribed, matched to the calendar or uploaded.
    /// Relaunching (e.g. a mandatory update) would lose that work.
    pub fn is_busy(&self) -> bool {
        self.active_meeting_id().is_some() || self.sync.is_busy()
    }

    /// Start a new meeting. Returns the meeting_id.
    pub fn start(&self, title: Option<String>, is_daily: bool) -> Result<i64> {
        let mut slot = self.active.lock().unwrap();
        if let Some(active) = slot.as_ref() {
            return Err(anyhow!("Meeting already in progress (id={})", active.id));
        }

        let settings = get_settings(&self.app);
        let started_at = Utc::now().timestamp();
        let title = title.unwrap_or_else(|| default_title(started_at));
        let will_sync = cloud_sync_configured(&settings);
        let id = self.store.insert(
            &title,
            started_at,
            is_daily,
            will_sync.then_some(SYNC_PENDING),
        )?;

        // Make sure the transcription engine is hot before we start capturing.
        // Skip preloading when cloud transcription is the primary mode — the
        // cloud path in TranscriptionManager.transcribe() will handle it, and
        // the fallback auto-loads a local model if needed.
        let use_cloud = settings.transcription_mode == crate::settings::TranscriptionMode::Cloud
            && crate::cloud_transcription::is_cloud_available(&settings);
        if !use_cloud {
            if let Some(tm) = self.app.try_state::<Arc<TranscriptionManager>>() {
                if let Err(e) = tm.load_model(&settings.selected_model) {
                    warn!(
                        "Meeting {id}: failed to preload transcription model {}: {e}",
                        settings.selected_model
                    );
                }
            }
        }

        // Prep a per-meeting directory for raw WAV files, iff audio persistence
        // is enabled. Store the path on the meeting record so the UI can resolve
        // playback files later.
        let audio_dir = if settings.save_meeting_audio {
            let dir = portable::app_data_dir(&self.app)
                .map_err(|e| anyhow!("Failed to resolve app data dir: {e}"))?
                .join("meetings")
                .join(id.to_string());
            fs::create_dir_all(&dir)
                .map_err(|e| anyhow!("Failed to create meeting audio dir: {e}"))?;
            self.store
                .set_audio_path(id, dir.to_string_lossy().as_ref())?;
            Some(dir)
        } else {
            None
        };

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stats: MeetingStats = Arc::default();
        let diag: MeetingDiag = Arc::default();
        let mut handles = Vec::new();
        // One clock for both sources: chunk offsets of mic and system audio
        // must be comparable, or the dialog view interleaves them wrongly.
        // System capture opens after the mic loop starts (ScreenCaptureKit
        // can take a while), so a per-thread clock shifted it earlier.
        let meeting_start = Instant::now();

        // Always spawn the microphone loop (cpal).
        let mic_device = resolve_mic_device(&settings);
        let mic_capture =
            open_cpal(mic_device).map_err(|e| anyhow!("Failed to open mic capture: {e}"))?;
        let mic_wav_path = audio_dir.as_ref().map(|d| d.join("mic.wav"));
        handles.push(spawn_recording_loop(
            self.app.clone(),
            self.store.clone(),
            id,
            stop_flag.clone(),
            "mic".to_string(),
            mic_capture,
            mic_wav_path,
            stats.clone(),
            meeting_start,
        )?);

        // Optionally spawn the system-audio loop.
        if settings.capture_system_audio {
            match resolve_system_audio_device() {
                SystemAudioStatus::Available { source, label } => {
                    info!("Meeting {id}: capturing system audio via '{label}'");
                    let backend = match &source {
                        SystemAudioSource::CpalDevice(_) => "cpal",
                        SystemAudioSource::WasapiLoopback => "wasapi",
                        SystemAudioSource::MacosNative => "macos_native",
                    };
                    set_diag(&diag, "system_capture_backend", serde_json::json!(backend));
                    let capture_result: Result<SourceCapture> = match source {
                        SystemAudioSource::CpalDevice(dev) => open_cpal(Some(dev)),
                        #[cfg(target_os = "windows")]
                        SystemAudioSource::WasapiLoopback => open_wasapi(),
                        #[cfg(not(target_os = "windows"))]
                        SystemAudioSource::WasapiLoopback => {
                            Err(anyhow!("WasapiLoopback requested on non-Windows build"))
                        }
                        #[cfg(target_os = "macos")]
                        SystemAudioSource::MacosNative => open_macos_native(),
                        #[cfg(not(target_os = "macos"))]
                        SystemAudioSource::MacosNative => {
                            Err(anyhow!("MacosNative requested on non-macOS build"))
                        }
                    };
                    match capture_result {
                        Ok(capture) => {
                            let sys_wav_path = audio_dir.as_ref().map(|d| d.join("system.wav"));
                            handles.push(spawn_recording_loop(
                                self.app.clone(),
                                self.store.clone(),
                                id,
                                stop_flag.clone(),
                                "system".to_string(),
                                capture,
                                sys_wav_path,
                                stats.clone(),
                                meeting_start,
                            )?)
                        }
                        Err(e) => {
                            warn!("Meeting {id}: failed to open system-audio capture — {e}");
                            set_diag(
                                &diag,
                                "system_capture_error",
                                serde_json::json!(crate::cloud_sync::truncate_chars(
                                    &e.to_string(),
                                    300
                                )),
                            );
                            let _ = (MeetingStateEvent::Error {
                                meeting_id: Some(id),
                                message: format!("System audio capture failed: {e}"),
                            })
                            .emit(&self.app);
                        }
                    }
                }
                SystemAudioStatus::NotConfigured { install_hint } => {
                    warn!(
                        "Meeting {id}: system-audio requested but not configured — {install_hint}"
                    );
                    set_diag(
                        &diag,
                        "system_capture_backend",
                        serde_json::json!("not_configured"),
                    );
                    let _ = (MeetingStateEvent::Error {
                        meeting_id: Some(id),
                        message: format!("System audio is enabled but not set up: {install_hint}"),
                    })
                    .emit(&self.app);
                }
                SystemAudioStatus::NotYetSupported { message } => {
                    warn!("Meeting {id}: system-audio not supported — {message}");
                    set_diag(
                        &diag,
                        "system_capture_backend",
                        serde_json::json!("not_supported"),
                    );
                    let _ = (MeetingStateEvent::Error {
                        meeting_id: Some(id),
                        message,
                    })
                    .emit(&self.app);
                }
            }
        } else {
            set_diag(
                &diag,
                "system_capture_backend",
                serde_json::json!("disabled"),
            );
        }

        if let Some(h) = spawn_output_probe(id, stop_flag.clone(), diag.clone()) {
            handles.push(h);
        }

        // Look up the calendar event this recording belongs to. Off-thread
        // and best-effort: a slow or missing calendar never delays capture.
        let calendar_handle = if will_sync {
            let app = self.app.clone();
            let store = self.store.clone();
            let diag = diag.clone();
            let now = Utc::now();
            let spawned = thread::Builder::new()
                .name(format!("meeting-{id}-calendar"))
                .spawn(move || {
                    let lookup =
                        detect_calendar_context(&app, &store, id, LookupWhen::Start, now, now);
                    lookup.record(&diag, LookupWhen::Start);
                });
            match spawned {
                Ok(h) => Some(h),
                Err(e) => {
                    warn!("Meeting {id}: could not start calendar lookup: {e}");
                    None
                }
            }
        } else {
            None
        };

        *slot = Some(ActiveMeeting {
            id,
            started: Instant::now(),
            stop_flag,
            handles,
            calendar_handle,
            stats,
            diag,
        });

        let _ = (MeetingStateEvent::Started {
            meeting_id: id,
            title,
        })
        .emit(&self.app);

        Ok(id)
    }

    /// Replace the participant list of a meeting (user edits).
    pub fn set_participants(
        &self,
        meeting_id: i64,
        participants: Vec<MeetingParticipant>,
    ) -> Result<()> {
        let cleaned = clean_participants(participants);
        self.store.set_participants(meeting_id, &cleaned)
    }

    /// Stop the active meeting. Returns the meeting id immediately and
    /// spawns a background thread to join recording threads, finalize the
    /// DB record, and optionally cloud-sync. This keeps the Tauri command
    /// thread free so the UI never freezes while waiting for an in-flight
    /// transcription to finish.
    pub fn stop(&self) -> Result<i64> {
        let mut slot = self.active.lock().unwrap();
        let active = slot
            .take()
            .ok_or_else(|| anyhow!("No meeting in progress"))?;

        let meeting_id = active.id;

        // Busy from before the slot is released until the upload is done, so
        // `is_busy` never reports a gap a relaunch could slip into.
        let busy = self.sync.busy_guard();
        let claim = self.sync.claim(meeting_id);

        // Signal recording threads to exit as soon as possible.
        active.stop_flag.store(true, Ordering::SeqCst);
        drop(slot);

        // Measure now: joining below waits for the last chunk's transcription,
        // which is not part of the meeting.
        let duration_ms = active.started.elapsed().as_millis() as i64;
        let ended_at = Utc::now().timestamp();

        // Move the heavy join + finalize work to a background thread so the
        // calling Tauri command returns instantly.
        let store = self.store.clone();
        let app = self.app.clone();
        thread::spawn(move || {
            let _busy = busy;
            let _claim = claim;
            let ActiveMeeting {
                handles,
                calendar_handle,
                stats,
                diag,
                ..
            } = active;
            // Wait for recording threads to finish (may block briefly if
            // a transcription was already in flight when stop was signalled).
            for h in handles {
                let _ = h.join();
            }

            if let Err(e) = store.finalize(meeting_id, ended_at, duration_ms) {
                error!("Failed to finalize meeting {meeting_id}: {e}");
            }

            // Opportunistic retention cleanup.
            let settings = get_settings(&app);
            if let Some(cutoff) =
                retention_cutoff_ts(&settings.recording_retention_period, ended_at)
            {
                match store.prune_older_than(cutoff) {
                    Ok(n) if n > 0 => {
                        info!("Pruned {n} old meeting(s) past the retention cutoff")
                    }
                    Ok(_) => {}
                    Err(e) => warn!("Meeting retention prune failed: {e}"),
                }
            }

            let _ = (MeetingStateEvent::Stopped { meeting_id }).emit(&app);

            if !cloud_sync_configured(&settings) {
                return;
            }

            // The start-time lookup only knew when the recording began; now
            // the real window is known, so match again unless the user has
            // already confirmed the attendees.
            if let Some(h) = calendar_handle {
                let _ = h.join();
            }
            match store.get(meeting_id) {
                Ok(Some(r))
                    if r.participants_source.as_deref() == Some(PARTICIPANTS_SOURCE_USER) =>
                {
                    set_diag(
                        &diag,
                        "calendar_lookup_stop",
                        serde_json::json!("skipped_user_edited"),
                    );
                }
                Ok(Some(r)) => {
                    if let (Some(start), Some(end)) = (
                        DateTime::from_timestamp(r.started_at, 0),
                        DateTime::from_timestamp(ended_at, 0),
                    ) {
                        detect_calendar_context(
                            &app,
                            &store,
                            meeting_id,
                            LookupWhen::Stop,
                            start,
                            end,
                        )
                        .record(&diag, LookupWhen::Stop);
                    }
                }
                Ok(None) => {}
                Err(e) => warn!("Failed to load meeting {meeting_id} for calendar lookup: {e}"),
            }

            let diagnostics = build_diagnostics(&settings, &stats, &diag);
            if let Err(e) = store.set_client_diagnostics(meeting_id, &diagnostics) {
                warn!("Meeting {meeting_id}: failed to store diagnostics: {e}");
            }
            if let Err(e) = run_upload(&app, &store, meeting_id, UploadKind::AfterStop) {
                warn!("Cloud sync failed for meeting {meeting_id}: {e}");
            }
        });

        Ok(meeting_id)
    }

    /// Retry pending/failed uploads in the background: shortly after start-up
    /// and then periodically, each meeting with exponential backoff.
    pub fn spawn_sync_retry_worker(&self) {
        let app = self.app.clone();
        let store = self.store.clone();
        let sync = self.sync.clone();
        let spawned = thread::Builder::new()
            .name("meeting-sync-retry".into())
            .spawn(move || {
                thread::sleep(RETRY_FIRST_CHECK);
                loop {
                    retry_due_uploads(&app, &store, &sync);
                    thread::sleep(RETRY_CHECK_INTERVAL);
                }
            });
        if let Err(e) = spawned {
            warn!("Could not start the meeting upload retry worker: {e}");
        }
    }
}

/// Seconds to wait after `attempts` failed uploads before the next one.
fn retry_backoff_secs(attempts: u32) -> i64 {
    if attempts == 0 {
        return 0;
    }
    let factor = 1i64 << (attempts - 1).min(10);
    (RETRY_BASE_SECS * factor).min(RETRY_MAX_SECS)
}

fn retry_due_uploads(app: &AppHandle, store: &Arc<MeetingsStore>, sync: &Arc<SyncTracker>) {
    let settings = get_settings(app);
    if !cloud_sync_configured(&settings) {
        return;
    }
    let candidates = match store.sync_candidates() {
        Ok(c) => c,
        Err(e) => {
            warn!("Upload retry: listing meetings failed: {e}");
            return;
        }
    };
    let now = Utc::now().timestamp();
    for c in candidates {
        if c.attempts >= RETRY_MAX_ATTEMPTS {
            continue;
        }
        let due_at = c.last_attempt_at.unwrap_or(0) + retry_backoff_secs(c.attempts);
        if now < due_at {
            continue;
        }
        // Skips meetings being uploaded right now (e.g. just stopped).
        let Some(_claim) = sync.claim(c.id) else {
            continue;
        };
        let _busy = sync.busy_guard();
        info!(
            "Retrying upload of meeting {} (attempt {})",
            c.id,
            c.attempts + 1
        );
        if let Err(e) = run_upload(app, store, c.id, UploadKind::AutoRetry) {
            warn!("Upload retry of meeting {} failed: {e}", c.id);
        }
    }
}

/// Upload one meeting with its stored diagnostics and record the outcome
/// (`sync_state`, events for the UI). The caller holds the meeting's
/// [`UploadClaim`] and a [`BusyGuard`].
pub fn run_upload(
    app: &AppHandle,
    store: &MeetingsStore,
    meeting_id: i64,
    kind: UploadKind,
) -> Result<()> {
    use crate::cloud_sync;

    let settings = get_settings(app);
    let record = store
        .get(meeting_id)?
        .ok_or_else(|| anyhow!("Meeting {meeting_id} not found"))?;

    let _ = (cloud_sync::CloudSyncEvent::Syncing { meeting_id }).emit(app);
    let attempt = store
        .mark_sync_attempt(meeting_id, Utc::now().timestamp())
        .unwrap_or_else(|e| {
            warn!("Meeting {meeting_id}: failed to count upload attempt: {e}");
            0
        });

    let mut diagnostics = store
        .client_diagnostics(meeting_id)
        .ok()
        .flatten()
        .filter(|d| d.is_object())
        .unwrap_or_else(|| base_diagnostics(&settings));
    if let Some(obj) = diagnostics.as_object_mut() {
        obj.insert("upload_kind".into(), serde_json::json!(kind.as_str()));
        obj.insert("sync_attempt".into(), serde_json::json!(attempt));
        obj.insert(
            "uploading_app_version".into(),
            serde_json::json!(env!("CARGO_PKG_VERSION")),
        );
        // The attendees may have been edited since the recording.
        obj.insert(
            "participants".into(),
            serde_json::json!(record.participants.len()),
        );
        obj.insert(
            "participants_source".into(),
            serde_json::json!(record.participants_source),
        );
        obj.insert(
            "calendar_matched".into(),
            serde_json::json!(record.calendar_event_id.is_some()),
        );
    }

    match cloud_sync::sync_meeting(
        &settings,
        &record,
        kind == UploadKind::Manual,
        Some(diagnostics),
    ) {
        Ok(outcome) => {
            let resp = outcome.response;
            info!(
                "Meeting {meeting_id} synced to cloud ({}): {}",
                kind.as_str(),
                resp.stored_record_id
            );
            if let Some(ref title) = resp.suggested_title {
                match store.rename(meeting_id, title) {
                    Ok(()) => info!("Meeting {meeting_id} renamed to: {title}"),
                    Err(e) => warn!("Failed to apply suggested title: {e}"),
                }
            }
            if let Err(e) = store.set_sync_state(meeting_id, SYNC_SYNCED) {
                warn!("Meeting {meeting_id}: failed to store sync state: {e}");
            }
            let _ = (cloud_sync::CloudSyncEvent::Success {
                meeting_id,
                remote_id: resp.stored_record_id,
            })
            .emit(app);
            if outcome.calendar_context_dropped.is_some() {
                let _ = (cloud_sync::CloudSyncEvent::Warning {
                    meeting_id,
                    code: "calendar_context_dropped".to_string(),
                })
                .emit(app);
            }
            Ok(())
        }
        Err(e) => {
            if let Err(db) = store.set_sync_state(meeting_id, SYNC_FAILED) {
                warn!("Meeting {meeting_id}: failed to store sync state: {db}");
            }
            let _ = (cloud_sync::CloudSyncEvent::Failed {
                meeting_id,
                error: e.to_string(),
            })
            .emit(app);
            Err(e)
        }
    }
}

/// Diagnostics that don't depend on a recording (also the fallback for
/// meetings recorded before diagnostics were stored).
fn base_diagnostics(settings: &crate::settings::AppSettings) -> serde_json::Value {
    serde_json::json!({
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "transcription_mode": format!("{:?}", settings.transcription_mode).to_lowercase(),
        "capture_system_audio": settings.capture_system_audio,
    })
}

/// Content-free diagnostics of a finished recording.
fn build_diagnostics(
    settings: &crate::settings::AppSettings,
    stats: &MeetingStats,
    diag: &MeetingDiag,
) -> serde_json::Value {
    let sources = stats.lock().map(|m| m.clone()).unwrap_or_default();
    let modes: HashSet<&str> = sources.values().map(|s| s.chunking.as_str()).collect();
    let chunking = match modes.len() {
        0 => "none".to_string(),
        1 => modes.into_iter().next().unwrap_or_default().to_string(),
        _ => "mixed".to_string(),
    };
    let mut out = base_diagnostics(settings);
    if let Some(obj) = out.as_object_mut() {
        obj.insert("sources".into(), serde_json::json!(sources));
        obj.insert("chunking".into(), serde_json::json!(chunking));
        obj.insert(
            "output_device_kind".into(),
            serde_json::json!(output_device_hint().kind),
        );
        if let Ok(d) = diag.lock() {
            obj.insert(
                "output_device_kind_samples".into(),
                serde_json::json!(d.output_kinds),
            );
            for (k, v) in &d.fields {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// Sample the default output device kind every minute while recording, so
/// diagnostics show whether the call played through speakers.
fn spawn_output_probe(
    meeting_id: i64,
    stop_flag: Arc<AtomicBool>,
    diag: MeetingDiag,
) -> Option<JoinHandle<()>> {
    let spawned = thread::Builder::new()
        .name(format!("meeting-{meeting_id}-output-probe"))
        .spawn(move || loop {
            let kind = output_device_hint().kind;
            if let Ok(mut d) = diag.lock() {
                *d.output_kinds.entry(kind).or_insert(0) += 1;
            }
            let deadline = Instant::now() + OUTPUT_PROBE_INTERVAL;
            while Instant::now() < deadline {
                if stop_flag.load(Ordering::SeqCst) {
                    return;
                }
                thread::sleep(Duration::from_millis(250));
            }
        });
    match spawned {
        Ok(h) => Some(h),
        Err(e) => {
            warn!("Meeting {meeting_id}: could not start output-device probe: {e}");
            None
        }
    }
}

fn cloud_sync_configured(settings: &crate::settings::AppSettings) -> bool {
    settings.cloud_sync_enabled
        && settings
            .cloud_sync_url
            .as_deref()
            .is_some_and(|u| !u.is_empty())
        && settings
            .cloud_sync_api_key
            .as_deref()
            .is_some_and(|k| !k.is_empty())
}

/// Trim names/emails, drop empty rows and duplicates (by email, else name).
fn clean_participants(participants: Vec<MeetingParticipant>) -> Vec<MeetingParticipant> {
    let mut out: Vec<MeetingParticipant> = Vec::new();
    for p in participants {
        let name = p.name.trim().to_string();
        let email = p
            .email
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty());
        if name.is_empty() && email.is_none() {
            continue;
        }
        let duplicate = out.iter().any(|o| match (&o.email, &email) {
            (Some(a), Some(b)) => a == b,
            _ => o.name.eq_ignore_ascii_case(&name),
        });
        if !duplicate {
            out.push(MeetingParticipant { name, email });
        }
    }
    out
}

/// The participants (and their source) after a calendar match:
/// * nobody set them, or the calendar did → the event's attendees;
/// * the user added people → theirs plus the event's (deduplicated);
/// * the user removed everyone → stays empty.
fn merge_calendar_participants(
    current: &[MeetingParticipant],
    source: Option<&str>,
    detected: &[MeetingParticipant],
) -> (Vec<MeetingParticipant>, Option<String>) {
    if source == Some(PARTICIPANTS_SOURCE_USER) {
        if current.is_empty() {
            return (Vec::new(), Some(PARTICIPANTS_SOURCE_USER.to_string()));
        }
        let merged = clean_participants(current.iter().chain(detected).cloned().collect());
        return (merged, Some(PARTICIPANTS_SOURCE_USER.to_string()));
    }
    (
        clean_participants(detected.to_vec()),
        Some(PARTICIPANTS_SOURCE_CALENDAR.to_string()),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LookupWhen {
    /// Recording just started: the event in progress.
    Start,
    /// Recording ended: the event overlapping it the most.
    Stop,
}

/// Outcome of one calendar lookup, for diagnostics.
#[derive(Debug, Default)]
struct CalendarLookup {
    /// "not_connected" | "failed" | "no_overlap" | "matched"
    result: &'static str,
    event_id: Option<String>,
    event_start: Option<String>,
    candidates: usize,
}

impl CalendarLookup {
    fn record(&self, diag: &MeetingDiag, when: LookupWhen) {
        let Ok(mut d) = diag.lock() else {
            return;
        };
        let suffix = match when {
            LookupWhen::Start => "start",
            LookupWhen::Stop => "stop",
        };
        d.fields.insert(
            format!("calendar_lookup_{suffix}"),
            serde_json::json!(self.result),
        );
        d.fields.insert(
            format!("calendar_candidates_{suffix}"),
            serde_json::json!(self.candidates),
        );
        // Overall result: the stop lookup wins when it matched a different
        // event; otherwise the first match stands.
        if self.result == "matched" {
            let overall = match when {
                LookupWhen::Start => {
                    d.start_event_id = self.event_id.clone();
                    "matched_at_start"
                }
                LookupWhen::Stop if d.start_event_id == self.event_id => "matched_at_start",
                LookupWhen::Stop => "matched_at_stop",
            };
            d.fields
                .insert("calendar_lookup".into(), serde_json::json!(overall));
            d.fields.insert(
                "calendar_event_start".into(),
                serde_json::json!(self.event_start),
            );
            d.fields.insert(
                "calendar_candidates".into(),
                serde_json::json!(self.candidates),
            );
        } else if !d
            .fields
            .get("calendar_lookup")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.starts_with("matched"))
        {
            d.fields
                .insert("calendar_lookup".into(), serde_json::json!(self.result));
            d.fields.insert(
                "calendar_candidates".into(),
                serde_json::json!(self.candidates),
            );
        }
    }
}

/// Whether a calendar is connected: the backend's answer, else inferred from
/// the events, else from the integrations list. `None` = unknown.
fn calendar_connected(
    settings: &crate::settings::AppSettings,
    reported: Option<bool>,
    candidates: usize,
) -> Option<bool> {
    if reported.is_some() {
        return reported;
    }
    if candidates > 0 {
        return Some(true);
    }
    crate::cloud_sync::fetch_integrations_status(settings)
        .ok()
        .map(|s| {
            s.integrations
                .iter()
                .any(|i| i.connected && i.provider.contains("calendar"))
        })
}

/// Match the recording to a calendar event and store its attendees. Never
/// fails the meeting: errors are logged and the meeting keeps whatever
/// participants it has.
fn detect_calendar_context(
    app: &AppHandle,
    store: &MeetingsStore,
    meeting_id: i64,
    when: LookupWhen,
    rec_start: DateTime<Utc>,
    rec_end: DateTime<Utc>,
) -> CalendarLookup {
    let settings = get_settings(app);
    let margin = chrono::Duration::minutes(30);
    let fetched = match crate::cloud_sync::fetch_calendar_events(
        &settings,
        rec_start - margin,
        rec_end + margin,
    ) {
        Ok(fetched) => fetched,
        Err(e) => {
            warn!("Meeting {meeting_id}: calendar lookup failed: {e}");
            return CalendarLookup {
                result: "failed",
                ..Default::default()
            };
        }
    };
    let candidates = fetched.events.len();
    let picked = match when {
        LookupWhen::Start => crate::cloud_sync::pick_event_at_start(&fetched.events, rec_start),
        LookupWhen::Stop => crate::cloud_sync::pick_best_event(&fetched.events, rec_start, rec_end),
    };
    let Some(event) = picked else {
        let result = if calendar_connected(&settings, fetched.calendar_connected, candidates)
            == Some(false)
        {
            "not_connected"
        } else {
            "no_overlap"
        };
        info!("Meeting {meeting_id}: no calendar event for the recording ({result}, {candidates} candidates)");
        return CalendarLookup {
            result,
            candidates,
            ..Default::default()
        };
    };
    let detected = clean_participants(event.participants());
    match store.set_calendar_context(meeting_id, &event.id, event.title.as_deref(), &detected) {
        Ok(participants) => {
            info!(
                "Meeting {meeting_id}: matched calendar event with {} attendee(s) ({when:?})",
                detected.len()
            );
            let _ = (MeetingCalendarContextEvent {
                meeting_id,
                calendar_event_id: Some(event.id.clone()),
                calendar_event_title: event.title.clone(),
                participants,
            })
            .emit(app);
        }
        Err(e) => warn!("Meeting {meeting_id}: failed to store calendar context: {e}"),
    }
    CalendarLookup {
        result: "matched",
        event_id: Some(event.id.clone()),
        event_start: event.start.clone(),
        candidates,
    }
}

/// What the default output device looks like, for the "use headphones" hint.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct OutputDeviceHint {
    pub name: Option<String>,
    /// "headphones" | "speakers" | "unknown"
    pub kind: String,
}

/// Classify an output device by name. Only names that clearly say
/// "speaker" count as speakers; virtual/aggregate devices stay unknown so we
/// don't nag people we can't judge.
pub fn classify_output_device(name: &str) -> &'static str {
    let n = name.to_lowercase();
    const HEADPHONES: &[&str] = &[
        "headphone",
        "headset",
        "earphone",
        "earbud",
        "airpods",
        "buds",
        "beats",
        "auricular",
        "audífono",
        "audifono",
        "hands-free",
        "handsfree",
        "jabra",
        "bose qc",
        "wh-1000",
        "wf-1000",
        "plantronics",
        "poly ",
    ];
    const SPEAKERS: &[&str] = &[
        "speaker",
        "altavoz",
        "altavoces",
        "bocina",
        "parlante",
        "display audio",
        "built-in output",
        "internal speakers",
    ];
    if HEADPHONES.iter().any(|k| n.contains(k)) {
        "headphones"
    } else if SPEAKERS.iter().any(|k| n.contains(k)) {
        "speakers"
    } else {
        "unknown"
    }
}

pub fn output_device_hint() -> OutputDeviceHint {
    use cpal::traits::{DeviceTrait, HostTrait};
    let name = cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok());
    let kind = name
        .as_deref()
        .map(classify_output_device)
        .unwrap_or("unknown")
        .to_string();
    OutputDeviceHint { name, kind }
}

/// Resolve the mic device from settings, or default to cpal's default input.
fn resolve_mic_device(settings: &crate::settings::AppSettings) -> Option<cpal::Device> {
    settings.selected_microphone.as_ref().and_then(|name| {
        list_input_devices()
            .ok()?
            .into_iter()
            .find(|d| d.name == *name)
            .map(|d| d.device)
    })
}

fn retention_cutoff_ts(
    policy: &crate::settings::RecordingRetentionPeriod,
    now: i64,
) -> Option<i64> {
    use crate::settings::RecordingRetentionPeriod as R;
    match policy {
        R::Never | R::PreserveLimit => None, // PreserveLimit is count-based, skip for meetings
        R::Days3 => Some(now - 3 * 24 * 60 * 60),
        R::Weeks2 => Some(now - 2 * 7 * 24 * 60 * 60),
        R::Months3 => Some(now - 3 * 30 * 24 * 60 * 60),
    }
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
    capture: SourceCapture,
    wav_path: Option<PathBuf>,
    stats: MeetingStats,
    meeting_start: Instant,
) -> Result<JoinHandle<()>> {
    let handle = thread::Builder::new()
        .name(format!("meeting-{meeting_id}-{source}"))
        .spawn(move || {
            if let Err(e) = run_recording_loop(
                &app,
                &store,
                meeting_id,
                &stop_flag,
                &source,
                capture,
                wav_path,
                &stats,
                meeting_start,
            ) {
                error!("Meeting {meeting_id} [{source}] recording loop failed: {e}");
                let _ = (MeetingStateEvent::Error {
                    meeting_id: Some(meeting_id),
                    message: format!("{source}: {e}"),
                })
                .emit(&app);
            }
        })?;
    Ok(handle)
}

/// Load the Silero VAD used to find pauses. `None` (fixed-length chunks, no
/// silence gating) if the model can't be loaded.
fn load_vad(app: &AppHandle) -> Option<SileroVad> {
    let path = match app.path().resolve(
        "resources/models/silero_vad_v4.onnx",
        tauri::path::BaseDirectory::Resource,
    ) {
        Ok(p) => p,
        Err(e) => {
            warn!("Could not resolve VAD model path: {e}");
            return None;
        }
    };
    match SileroVad::new(&path, 0.3) {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("Could not create SileroVad for meeting chunking: {e}");
            None
        }
    }
}

/// Why a chunk ended where it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CutKind {
    /// In a pause after the minimum length.
    Silence,
    /// No pause before the maximum: at the last non-speech frame, or hard.
    Forced,
    /// No speech flags at all: fixed-length chunks.
    Fixed,
}

/// Where to end the next chunk, in samples, given the per-frame speech flags
/// of the pending audio (`None` = no flags) and how many samples are pending.
///
/// * once `CHUNK_MIN_SECONDS` are pending, cut in the middle of the first
///   pause of `CUT_SILENCE_FRAMES` that ends after that point;
/// * at `CHUNK_MAX_SECONDS` with no such pause, cut at the last non-speech
///   frame past the minimum, or hard-cut at the maximum.
///
/// Chunks never overlap: the remainder starts the next chunk.
fn find_chunk_cut(speech: Option<&[bool]>, pending_samples: usize) -> Option<(usize, CutKind)> {
    let min_samples = CHUNK_MIN_SECONDS * SAMPLE_RATE;
    let max_samples = CHUNK_MAX_SECONDS * SAMPLE_RATE;
    let Some(flags) = speech else {
        return (pending_samples >= min_samples).then_some((min_samples, CutKind::Fixed));
    };

    let min_frame = min_samples / VAD_FRAME_SAMPLES;
    let max_frame = max_samples / VAD_FRAME_SAMPLES;
    let mut silent_run = 0usize;
    for (i, &is_speech) in flags.iter().enumerate().take(max_frame) {
        silent_run = if is_speech { 0 } else { silent_run + 1 };
        if i + 1 >= min_frame && silent_run >= CUT_SILENCE_FRAMES {
            let cut_frame = i + 1 - silent_run / 2;
            return Some((cut_frame * VAD_FRAME_SAMPLES, CutKind::Silence));
        }
    }

    if pending_samples < max_samples {
        return None;
    }
    let fallback = flags
        .iter()
        .enumerate()
        .take(max_frame)
        .skip(min_frame)
        .rev()
        .find(|(_, &is_speech)| !is_speech)
        .map(|(i, _)| (i + 1) * VAD_FRAME_SAMPLES);
    // Frame-aligned, so the remaining flags still line up with the samples.
    Some((
        fallback.unwrap_or(max_frame * VAD_FRAME_SAMPLES),
        CutKind::Forced,
    ))
}

/// Energy check used when the VAD is unavailable or keeps failing.
fn energy_is_speech(frame: &[f32]) -> bool {
    if frame.is_empty() {
        return false;
    }
    let mean_square = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
    mean_square.sqrt() > ENERGY_SPEECH_RMS
}

/// Per-frame speech detection for one source.
enum SpeechClassifier {
    Vad {
        detector: Box<SileroVad>,
        consecutive_errors: u32,
    },
    Energy,
}

/// One frame's classification.
struct FrameClass {
    speech: bool,
    vad_error: bool,
    /// The VAD was given up on with this frame.
    degraded: bool,
}

impl SpeechClassifier {
    fn mode(&self) -> &'static str {
        match self {
            SpeechClassifier::Vad { .. } => "vad",
            SpeechClassifier::Energy => "energy",
        }
    }

    /// A VAD error falls back to the energy check for that frame (treating
    /// it as speech made every chunk "speech" and defeated silence gating);
    /// after `VAD_MAX_CONSECUTIVE_ERRORS` in a row the VAD is dropped.
    fn classify(&mut self, frame: &[f32]) -> FrameClass {
        let SpeechClassifier::Vad {
            detector,
            consecutive_errors,
        } = self
        else {
            return FrameClass {
                speech: energy_is_speech(frame),
                vad_error: false,
                degraded: false,
            };
        };
        match detector.is_voice(frame) {
            Ok(speech) => {
                *consecutive_errors = 0;
                FrameClass {
                    speech,
                    vad_error: false,
                    degraded: false,
                }
            }
            Err(e) => {
                *consecutive_errors += 1;
                let degraded = *consecutive_errors >= VAD_MAX_CONSECUTIVE_ERRORS;
                if *consecutive_errors == 1 || degraded {
                    warn!("VAD failed on a frame ({consecutive_errors} in a row): {e}");
                }
                if degraded {
                    *self = SpeechClassifier::Energy;
                }
                FrameClass {
                    speech: energy_is_speech(frame),
                    vad_error: true,
                    degraded,
                }
            }
        }
    }
}

/// What to do with audio that arrives after a hole in a source's timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GapAction {
    /// Contiguous (within tolerance), or nothing pending to misplace.
    None,
    /// Fill this many ms of silence before the new samples.
    Pad(u64),
    /// Too long to fill: end the pending chunk first.
    Cut(u64),
}

/// `pending_end_ms`: where the pending audio ends on the meeting clock
/// (`None` = nothing pending). `arrival_start_ms`: where the new samples
/// start, judged by when they were collected.
fn gap_action(pending_end_ms: Option<u64>, arrival_start_ms: u64) -> GapAction {
    let Some(end) = pending_end_ms else {
        return GapAction::None;
    };
    let gap = arrival_start_ms.saturating_sub(end);
    if gap <= GAP_TOLERANCE_MS {
        GapAction::None
    } else if gap <= GAP_PAD_MAX_MS {
        GapAction::Pad(gap)
    } else {
        GapAction::Cut(gap)
    }
}

#[allow(clippy::too_many_arguments)]
fn run_recording_loop(
    app: &AppHandle,
    store: &Arc<MeetingsStore>,
    meeting_id: i64,
    stop_flag: &Arc<AtomicBool>,
    source: &str,
    mut recorder: SourceCapture,
    wav_path: Option<PathBuf>,
    stats: &MeetingStats,
    meeting_start: Instant,
) -> Result<()> {
    info!("Meeting {meeting_id} [{source}]: recorder opened, starting capture loop");

    // Open the WAV writer lazily so the file isn't created if we never capture
    // a valid chunk. Whisper's sample rate is 16 kHz mono.
    let mut wav_writer: Option<WavWriter<std::io::BufWriter<std::fs::File>>> = None;
    if let Some(path) = wav_path.as_ref() {
        let spec = WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE as u32,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        match WavWriter::create(path, spec) {
            Ok(w) => {
                info!(
                    "Meeting {meeting_id} [{source}]: persisting audio to {}",
                    path.display()
                );
                wav_writer = Some(w);
            }
            Err(e) => warn!("Meeting {meeting_id} [{source}]: failed to open WAV writer: {e}"),
        }
    }

    // Transcription runs on its own thread so capture never pauses for it.
    // (offset_ms, duration_ms, samples, speech_ratio)
    let (chunk_tx, chunk_rx) = mpsc::channel::<(u64, u64, Vec<f32>, f32)>();
    let worker = {
        let app = app.clone();
        let store = store.clone();
        let source = source.to_string();
        let stats = stats.clone();
        thread::Builder::new()
            .name(format!("meeting-{meeting_id}-{source}-transcribe"))
            .spawn(move || {
                for (offset_ms, duration_ms, samples, speech_ratio) in chunk_rx {
                    transcribe_chunk(
                        &app,
                        &store,
                        meeting_id,
                        &source,
                        offset_ms,
                        duration_ms,
                        samples,
                        speech_ratio,
                        &stats,
                    );
                }
            })?
    };

    // The recorder runs continuously; the loop drains it every
    // DRAIN_INTERVAL and cuts chunks at pauses, so nothing is lost between
    // chunks and words aren't split at arbitrary boundaries.
    let base_offset_ms = loop {
        if stop_flag.load(Ordering::SeqCst) {
            drop(chunk_tx);
            let _ = worker.join();
            let _ = recorder.close();
            return Ok(());
        }
        match recorder.start() {
            // Shared clock: offsets of mic and system audio stay comparable.
            Ok(()) => break meeting_start.elapsed().as_millis() as u64,
            Err(e) => {
                warn!("recorder.start failed: {e}");
                thread::sleep(Duration::from_millis(200));
            }
        }
    };

    let mut classifier = match load_vad(app) {
        Some(detector) => SpeechClassifier::Vad {
            detector: Box::new(detector),
            consecutive_errors: 0,
        },
        None => SpeechClassifier::Energy,
    };
    record_stat(stats, source, |s| {
        s.chunking = classifier.mode().to_string()
    });
    let mut pending: Vec<f32> = Vec::new();
    // Speech flag per complete 30-ms frame of `pending`.
    let mut frames: Vec<bool> = Vec::new();
    // Where `pending[0]` sits on the meeting clock. Anchored to when samples
    // are collected, not to a sample count, so a source whose stream pauses
    // (e.g. system audio when nothing plays) can't drift from the other.
    let mut pending_start_ms: Option<u64> = None;
    // Earliest offset the next chunk may have: chunks never overlap.
    let mut next_offset_ms: u64 = base_offset_ms;
    let samples_ms = |n: usize| (n as u64) * 1000 / SAMPLE_RATE as u64;
    let ms_samples = |ms: u64| (ms as usize) * SAMPLE_RATE / 1000;

    // Queue one chunk that starts at `start_ms`; returns where it ends.
    let emit = |chunk: Vec<f32>, flags: &[bool], start_ms: u64, next_offset_ms: &mut u64| {
        let offset_ms = start_ms.max(*next_offset_ms);
        let duration_ms = samples_ms(chunk.len());
        *next_offset_ms = offset_ms + duration_ms;
        record_stat(stats, source, |s| {
            s.chunks_captured += 1;
            s.audio_seconds += chunk.len() as f64 / SAMPLE_RATE as f64;
        });
        // Short chunk (<400ms) is almost always the tail at stop, skip it.
        if chunk.len() < SAMPLE_RATE * 2 / 5 {
            record_stat(stats, source, |s| s.skipped_tiny += 1);
            debug!(
                "Meeting {meeting_id} [{source}]: skipping tiny chunk ({} samples)",
                chunk.len()
            );
            return;
        }
        let speech_ratio = if flags.is_empty() {
            1.0 // no flags: let the transcriber decide
        } else {
            flags.iter().filter(|&&f| f).count() as f32 / flags.len() as f32
        };
        if chunk_tx
            .send((offset_ms, duration_ms, chunk, speech_ratio))
            .is_err()
        {
            warn!("Meeting {meeting_id} [{source}]: transcription worker exited early");
        }
    };

    loop {
        let deadline = Instant::now() + DRAIN_INTERVAL;
        while Instant::now() < deadline && !stop_flag.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(50));
        }
        let stopping = stop_flag.load(Ordering::SeqCst);

        let new_samples = if stopping {
            recorder.stop()
        } else {
            recorder.drain()
        };
        let collected_at_ms = meeting_start.elapsed().as_millis() as u64;
        let mut new_samples = match new_samples {
            Ok(s) => s,
            Err(e) => {
                warn!("Meeting {meeting_id} [{source}]: collecting samples failed: {e}");
                record_stat(stats, source, |s| s.drain_errors += 1);
                if stopping {
                    Vec::new()
                } else {
                    continue;
                }
            }
        };

        if !new_samples.is_empty() {
            let arrival_start_ms = collected_at_ms.saturating_sub(samples_ms(new_samples.len()));
            let pending_end_ms = pending_start_ms
                .filter(|_| !pending.is_empty())
                .map(|start| start + samples_ms(pending.len()));
            match gap_action(pending_end_ms, arrival_start_ms) {
                GapAction::None => {}
                GapAction::Pad(gap_ms) => {
                    // Silence where the source delivered nothing keeps the
                    // pending audio at its real moment (and the WAV aligned).
                    record_stat(stats, source, |s| {
                        s.gaps += 1;
                        s.gap_ms += gap_ms;
                        s.padded_ms += gap_ms;
                    });
                    let mut padded = vec![0.0f32; ms_samples(gap_ms)];
                    padded.append(&mut new_samples);
                    new_samples = padded;
                }
                GapAction::Cut(gap_ms) => {
                    record_stat(stats, source, |s| {
                        s.gaps += 1;
                        s.gap_ms += gap_ms;
                        s.gap_cuts += 1;
                    });
                    let chunk = std::mem::take(&mut pending);
                    let chunk_flags = std::mem::take(&mut frames);
                    let start = pending_start_ms.unwrap_or(next_offset_ms);
                    emit(chunk, &chunk_flags, start, &mut next_offset_ms);
                }
            }
            if pending.is_empty() {
                pending_start_ms = Some(arrival_start_ms.max(next_offset_ms));
            }
        }

        // Persist everything captured, so the WAV keeps the full timeline.
        if let Some(w) = wav_writer.as_mut() {
            for &s in &new_samples {
                let pcm = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                if let Err(e) = w.write_sample(pcm) {
                    warn!("Meeting {meeting_id} [{source}]: WAV write failed: {e}");
                    wav_writer = None;
                    break;
                }
            }
        }

        pending.extend_from_slice(&new_samples);

        // Classify the newly completed frames. Silero is stateful, so frames
        // go through one detector in order.
        let done = frames.len() * VAD_FRAME_SAMPLES;
        for frame in pending[done..].as_chunks::<VAD_FRAME_SAMPLES>().0 {
            let class = classifier.classify(frame);
            if class.vad_error {
                record_stat(stats, source, |s| {
                    s.vad_errors += 1;
                    if class.degraded {
                        s.vad_degraded = true;
                        s.chunking = "energy".to_string();
                    }
                });
            }
            frames.push(class.speech);
        }

        while let Some((cut, kind)) = find_chunk_cut(Some(&frames[..]), pending.len()) {
            let cut = cut.min(pending.len());
            if cut == 0 {
                break;
            }
            let rest = pending.split_off(cut);
            let chunk = std::mem::replace(&mut pending, rest);
            let cut_frames = (cut / VAD_FRAME_SAMPLES).min(frames.len());
            let chunk_flags: Vec<bool> = frames.drain(..cut_frames).collect();
            record_stat(stats, source, |s| match kind {
                CutKind::Silence => s.silence_cuts += 1,
                CutKind::Forced | CutKind::Fixed => s.forced_cuts += 1,
            });
            let start = pending_start_ms.unwrap_or(next_offset_ms);
            emit(chunk, &chunk_flags, start, &mut next_offset_ms);
            // The remainder follows the chunk directly.
            pending_start_ms = Some(next_offset_ms);
        }

        if stopping {
            // The final chunk (captured up to the moment stop was pressed) is
            // transcribed too; MeetingManager::stop() joins off the UI thread.
            if !pending.is_empty() {
                let chunk = std::mem::take(&mut pending);
                let chunk_flags = std::mem::take(&mut frames);
                let start = pending_start_ms.unwrap_or(next_offset_ms);
                emit(chunk, &chunk_flags, start, &mut next_offset_ms);
            }
            break;
        }
    }
    // Let the worker finish the queued chunks before the meeting is finalized
    // and synced.
    drop(chunk_tx);
    if worker.join().is_err() {
        error!("Meeting {meeting_id} [{source}]: transcription worker panicked");
    }

    let _ = recorder.close();
    if let Some(w) = wav_writer.take() {
        if let Err(e) = w.finalize() {
            warn!("Meeting {meeting_id} [{source}]: failed to finalize WAV: {e}");
        }
    }
    info!("Meeting {meeting_id} [{source}]: recording loop exited cleanly");
    Ok(())
}

/// VAD-gate and transcribe one chunk, then persist and emit it.
#[allow(clippy::too_many_arguments)]
fn transcribe_chunk(
    app: &AppHandle,
    store: &Arc<MeetingsStore>,
    meeting_id: i64,
    source: &str,
    offset_ms: u64,
    duration_ms: u64,
    samples: Vec<f32>,
    ratio: f32,
    stats: &MeetingStats,
) {
    // Skip chunks the VAD found (almost) no speech in: silence sent to
    // Whisper causes hallucinations ("Thank you for watching!", etc.).
    if ratio < MIN_SPEECH_RATIO {
        debug!("Meeting {meeting_id} [{source}]: skipping silent chunk (speech ratio {ratio:.2})");
        record_stat(stats, source, |s| s.skipped_silent += 1);
        return;
    }

    // The TranscriptionManager serialises internally — when two meeting
    // sources call it concurrently they queue on its mutex. That's
    // intentional: running the Whisper engine in two parallel lanes would
    // double the GPU/CPU load and OOM on low-end hardware.
    let Some(transcription_manager) = app.try_state::<Arc<TranscriptionManager>>() else {
        warn!("TranscriptionManager not yet registered; skipping chunk");
        record_stat(stats, source, |s| s.failed += 1);
        return;
    };

    match transcription_manager.inner().transcribe(samples) {
        Ok(text) => {
            let cleaned = text.trim().to_string();
            if cleaned.is_empty() {
                record_stat(stats, source, |s| s.empty_text += 1);
                return;
            }
            record_stat(stats, source, |s| s.transcribed += 1);
            let chunk = MeetingChunk {
                offset_ms,
                source: source.to_string(),
                text: cleaned,
                duration_ms: Some(duration_ms),
            };
            if let Err(e) = store.append_chunk(meeting_id, &chunk) {
                error!("Failed to persist chunk: {e}");
            }
            let _ = (MeetingTranscriptChunkEvent { meeting_id, chunk }).emit(app);
        }
        Err(e) => {
            error!("Transcription failed for meeting {meeting_id} [{source}]: {e}");
            record_stat(stats, source, |s| s.failed += 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAMES_PER_SECOND: usize = SAMPLE_RATE / VAD_FRAME_SAMPLES;

    fn speech(seconds: usize) -> Vec<bool> {
        vec![true; seconds * FRAMES_PER_SECOND]
    }

    #[test]
    fn no_cut_before_minimum() {
        let flags = vec![false; 5 * FRAMES_PER_SECOND];
        assert_eq!(
            find_chunk_cut(Some(&flags), flags.len() * VAD_FRAME_SAMPLES),
            None
        );
    }

    #[test]
    fn cuts_at_first_pause_after_minimum() {
        let mut flags = speech(14);
        flags.extend(vec![false; 20]);
        flags.extend(speech(3));
        let (cut, kind) =
            find_chunk_cut(Some(&flags), flags.len() * VAD_FRAME_SAMPLES).expect("cut expected");
        assert_eq!(kind, CutKind::Silence);
        let speech_end = speech(14).len() * VAD_FRAME_SAMPLES;
        assert!(cut > speech_end, "cut must be inside the pause");
        assert!(cut < speech_end + 20 * VAD_FRAME_SAMPLES);
        assert_eq!(cut % VAD_FRAME_SAMPLES, 0);
    }

    #[test]
    fn waits_for_pause_until_maximum() {
        let flags = speech(16);
        assert_eq!(
            find_chunk_cut(Some(&flags), flags.len() * VAD_FRAME_SAMPLES),
            None
        );
    }

    #[test]
    fn hard_cut_at_maximum_without_pause() {
        let flags = vec![true; 25 * FRAMES_PER_SECOND];
        let (cut, kind) =
            find_chunk_cut(Some(&flags), flags.len() * VAD_FRAME_SAMPLES).expect("cut expected");
        assert_eq!(kind, CutKind::Forced);
        assert!(cut <= CHUNK_MAX_SECONDS * SAMPLE_RATE);
        assert!(cut >= CHUNK_MAX_SECONDS * SAMPLE_RATE - VAD_FRAME_SAMPLES);
        assert_eq!(cut % VAD_FRAME_SAMPLES, 0);
    }

    #[test]
    fn fixed_chunks_without_vad() {
        assert_eq!(find_chunk_cut(None, 10 * SAMPLE_RATE), None);
        assert_eq!(
            find_chunk_cut(None, 13 * SAMPLE_RATE),
            Some((CHUNK_MIN_SECONDS * SAMPLE_RATE, CutKind::Fixed))
        );
    }

    #[test]
    fn energy_fallback_tells_silence_from_speech() {
        assert!(!energy_is_speech(&[0.0; VAD_FRAME_SAMPLES]));
        assert!(!energy_is_speech(&[0.002; VAD_FRAME_SAMPLES]));
        let tone: Vec<f32> = (0..VAD_FRAME_SAMPLES)
            .map(|i| 0.2 * (i as f32 * 0.3).sin())
            .collect();
        assert!(energy_is_speech(&tone));
    }

    #[test]
    fn gaps_are_padded_or_cut() {
        // Nothing pending: the new audio is simply anchored where it arrives.
        assert_eq!(gap_action(None, 90_000), GapAction::None);
        // Normal jitter between drains.
        assert_eq!(gap_action(Some(10_000), 10_600), GapAction::None);
        // System audio silent for 5 s: filled with silence.
        assert_eq!(gap_action(Some(10_000), 15_000), GapAction::Pad(5_000));
        // Silent for minutes: the pending chunk ends at its real moment.
        assert_eq!(gap_action(Some(10_000), 130_000), GapAction::Cut(120_000));
        // Late (buffered) samples never pad.
        assert_eq!(gap_action(Some(10_000), 9_000), GapAction::None);
    }

    #[test]
    fn retry_backoff_grows_and_caps() {
        assert_eq!(retry_backoff_secs(0), 0);
        assert_eq!(retry_backoff_secs(1), 5 * 60);
        assert_eq!(retry_backoff_secs(2), 10 * 60);
        assert_eq!(retry_backoff_secs(3), 20 * 60);
        assert_eq!(retry_backoff_secs(12), RETRY_MAX_SECS);
        assert_eq!(retry_backoff_secs(u32::MAX), RETRY_MAX_SECS);
    }

    fn person(name: &str, email: Option<&str>) -> MeetingParticipant {
        MeetingParticipant {
            name: name.into(),
            email: email.map(str::to_string),
        }
    }

    #[test]
    fn calendar_attendees_merge_with_user_edits() {
        let calendar = vec![person("Ana", Some("ana@x.co")), person("Luis", None)];

        // Nobody set them yet, or the calendar did: replaced.
        let (list, source) = merge_calendar_participants(&[], None, &calendar);
        assert_eq!(list.len(), 2);
        assert_eq!(source.as_deref(), Some(PARTICIPANTS_SOURCE_CALENDAR));
        let (list, _) = merge_calendar_participants(
            &[person("Old", Some("old@x.co"))],
            Some(PARTICIPANTS_SOURCE_CALENDAR),
            &calendar,
        );
        assert_eq!(list, clean_participants(calendar.clone()));

        // The user added someone before the lookup finished: both kept.
        let (list, source) = merge_calendar_participants(
            &[person("Pedro", None), person("ANA", Some("ANA@x.co"))],
            Some(PARTICIPANTS_SOURCE_USER),
            &calendar,
        );
        assert_eq!(source.as_deref(), Some(PARTICIPANTS_SOURCE_USER));
        let names: Vec<&str> = list.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Pedro", "ANA", "Luis"]);

        // The user removed everyone: stays empty.
        let (list, source) =
            merge_calendar_participants(&[], Some(PARTICIPANTS_SOURCE_USER), &calendar);
        assert!(list.is_empty());
        assert_eq!(source.as_deref(), Some(PARTICIPANTS_SOURCE_USER));
    }

    #[test]
    fn classifies_output_devices() {
        assert_eq!(classify_output_device("MacBook Pro Speakers"), "speakers");
        assert_eq!(
            classify_output_device("Speakers (Realtek(R) Audio)"),
            "speakers"
        );
        assert_eq!(classify_output_device("AirPods Pro de Angel"), "headphones");
        assert_eq!(classify_output_device("External Headphones"), "headphones");
        assert_eq!(classify_output_device("Galaxy Buds2"), "headphones");
        assert_eq!(classify_output_device("BlackHole 2ch"), "unknown");
    }

    #[test]
    fn cleans_participants() {
        let cleaned = clean_participants(vec![
            MeetingParticipant {
                name: " Ana ".into(),
                email: Some("ANA@x.co".into()),
            },
            MeetingParticipant {
                name: "Ana P".into(),
                email: Some("ana@x.co".into()),
            },
            MeetingParticipant {
                name: "  ".into(),
                email: None,
            },
            MeetingParticipant {
                name: "Luis".into(),
                email: None,
            },
            MeetingParticipant {
                name: "luis".into(),
                email: None,
            },
        ]);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[0].email.as_deref(), Some("ana@x.co"));
        assert_eq!(cleaned[1].name, "Luis");
    }
}
