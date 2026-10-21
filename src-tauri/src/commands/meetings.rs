//! Tauri commands exposing the Meeting Mode lifecycle + history to the frontend.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};

use crate::audio_toolkit::system_audio::{resolve_system_audio_device, SystemAudioStatus};
use crate::managers::meeting::{
    output_device_hint, MeetingManager, MeetingParticipant, MeetingRecord, OutputDeviceHint,
};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "state")]
pub enum SystemAudioAvailability {
    #[serde(rename = "available")]
    Available { label: String },
    #[serde(rename = "not_configured")]
    NotConfigured { install_hint: String },
    #[serde(rename = "not_yet_supported")]
    NotYetSupported { message: String },
}

#[tauri::command]
#[specta::specta]
pub fn get_system_audio_availability() -> SystemAudioAvailability {
    match resolve_system_audio_device() {
        SystemAudioStatus::Available { label, .. } => SystemAudioAvailability::Available { label },
        SystemAudioStatus::NotConfigured { install_hint } => {
            SystemAudioAvailability::NotConfigured { install_hint }
        }
        SystemAudioStatus::NotYetSupported { message } => {
            SystemAudioAvailability::NotYetSupported { message }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn meeting_start(
    app: AppHandle,
    title: Option<String>,
    is_daily: Option<bool>,
) -> Result<i64, String> {
    let mgr = app
        .try_state::<Arc<MeetingManager>>()
        .ok_or_else(|| "MeetingManager not initialized".to_string())?;
    mgr.start(title, is_daily.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn meeting_stop(app: AppHandle) -> Result<i64, String> {
    let mgr = app
        .try_state::<Arc<MeetingManager>>()
        .ok_or_else(|| "MeetingManager not initialized".to_string())?;
    mgr.stop().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn meeting_active(mgr: State<Arc<MeetingManager>>) -> Option<i64> {
    mgr.active_meeting_id()
}

/// True while a meeting records or a stopped one is still being finalized,
/// transcribed, matched to the calendar or uploaded. A relaunch (mandatory
/// update) must wait for it.
#[tauri::command]
#[specta::specta]
pub fn meeting_busy(mgr: State<Arc<MeetingManager>>) -> bool {
    mgr.is_busy()
}

#[tauri::command]
#[specta::specta]
pub fn list_meetings(
    mgr: State<Arc<MeetingManager>>,
    limit: Option<u32>,
) -> Result<Vec<MeetingRecord>, String> {
    mgr.store()
        .list(limit.unwrap_or(200) as usize)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting(
    mgr: State<Arc<MeetingManager>>,
    id: i64,
) -> Result<Option<MeetingRecord>, String> {
    mgr.store().get(id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_meeting(mgr: State<Arc<MeetingManager>>, id: i64) -> Result<(), String> {
    mgr.store().delete(id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn rename_meeting(
    mgr: State<Arc<MeetingManager>>,
    id: i64,
    title: String,
) -> Result<(), String> {
    mgr.store().rename(id, &title).map_err(|e| e.to_string())
}

/// Replace the participants of a meeting (the active one or a past one).
/// They're sent with the next upload of that meeting.
#[tauri::command]
#[specta::specta]
pub fn set_meeting_participants(
    mgr: State<Arc<MeetingManager>>,
    id: i64,
    participants: Vec<MeetingParticipant>,
) -> Result<(), String> {
    mgr.set_participants(id, participants)
        .map_err(|e| e.to_string())
}

/// The default output device and whether it looks like headphones, for the
/// "use headphones" hint while capturing system audio.
#[tauri::command]
#[specta::specta]
pub fn get_output_device_hint() -> OutputDeviceHint {
    output_device_hint()
}

/// Copy one of a meeting's audio tracks (mic.wav or system.wav) to a path
/// the user picked via a save-as dialog. Done in Rust so the destination
/// doesn't have to be inside the app's fs scope (the user may save anywhere).
/// `track` must be either "mic" or "system".
#[tauri::command]
#[specta::specta]
pub fn export_meeting_audio(
    mgr: State<Arc<MeetingManager>>,
    id: i64,
    track: String,
    destination: String,
) -> Result<(), String> {
    let filename = match track.as_str() {
        "mic" => "mic.wav",
        "system" => "system.wav",
        other => return Err(format!("Unknown audio track: {other}")),
    };

    let record = mgr
        .store()
        .get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Meeting {id} not found"))?;
    let audio_dir = record
        .audio_path
        .ok_or_else(|| format!("Meeting {id} has no saved audio"))?;
    let src = std::path::PathBuf::from(&audio_dir).join(filename);
    if !src.exists() {
        return Err(format!("{filename} does not exist for this meeting"));
    }

    let dest = std::path::PathBuf::from(&destination);
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            return Err(format!(
                "Destination directory does not exist: {}",
                parent.display()
            ));
        }
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("Copy failed: {e}"))?;
    Ok(())
}

/// Fails when the folder the user picked is gone (e.g. an unmounted drive).
fn ensure_parent_exists(dest: &std::path::Path) -> Result<(), String> {
    match dest.parent() {
        Some(parent) if !parent.exists() => Err(format!(
            "Destination directory does not exist: {}",
            parent.display()
        )),
        _ => Ok(()),
    }
}

fn has_extension(dest: &std::path::Path, allowed: &[&str]) -> bool {
    dest.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| allowed.iter().any(|a| e.eq_ignore_ascii_case(a)))
}

/// Save a transcript (already formatted by the frontend: plain text,
/// Markdown or subtitles) to a path the user picked via a save-as dialog.
/// Done in Rust for the same reason as `export_meeting_audio`. Only text
/// formats are written.
#[tauri::command]
#[specta::specta]
pub fn export_transcript_text(destination: String, contents: String) -> Result<(), String> {
    let dest = std::path::PathBuf::from(&destination);
    if !has_extension(&dest, &["txt", "md", "srt", "vtt"]) {
        return Err("The transcript must be saved as .txt, .md, .srt or .vtt".to_string());
    }
    ensure_parent_exists(&dest)?;
    std::fs::write(&dest, contents).map_err(|e| format!("Write failed: {e}"))?;
    Ok(())
}

/// Save a transcript as a Word document: `title`, a `subtitle` line (date,
/// duration) and one paragraph per turn with its label in bold.
#[tauri::command]
#[specta::specta]
pub fn export_transcript_docx(
    destination: String,
    title: String,
    subtitle: String,
    paragraphs: Vec<crate::docx::DocxParagraph>,
) -> Result<(), String> {
    let dest = std::path::PathBuf::from(&destination);
    if !has_extension(&dest, &["docx"]) {
        return Err("The document must be saved as a .docx file".to_string());
    }
    ensure_parent_exists(&dest)?;
    let bytes = crate::docx::build_docx(&title, &subtitle, &paragraphs);
    std::fs::write(&dest, bytes).map_err(|e| format!("Write failed: {e}"))?;
    Ok(())
}

/// Save a transcript as a PDF, with the same layout as the Word document.
#[tauri::command]
#[specta::specta]
pub fn export_transcript_pdf(
    destination: String,
    title: String,
    subtitle: String,
    paragraphs: Vec<crate::docx::DocxParagraph>,
) -> Result<(), String> {
    let dest = std::path::PathBuf::from(&destination);
    if !has_extension(&dest, &["pdf"]) {
        return Err("The document must be saved as a .pdf file".to_string());
    }
    ensure_parent_exists(&dest)?;
    let bytes = crate::pdf::build_pdf(&title, &subtitle, &paragraphs);
    std::fs::write(&dest, bytes).map_err(|e| format!("Write failed: {e}"))?;
    Ok(())
}
