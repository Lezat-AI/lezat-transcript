//! Tauri commands exposing the Meeting Mode lifecycle + history to the frontend.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};

use crate::audio_toolkit::system_audio::{resolve_system_audio_device, SystemAudioStatus};
use crate::managers::meeting::{MeetingManager, MeetingRecord};

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
) -> Result<i64, String> {
    let mgr = app
        .try_state::<Arc<MeetingManager>>()
        .ok_or_else(|| "MeetingManager not initialized".to_string())?;
    mgr.start(title).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn meeting_stop(app: AppHandle) -> Result<MeetingRecord, String> {
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
pub fn delete_meeting(
    mgr: State<Arc<MeetingManager>>,
    id: i64,
) -> Result<(), String> {
    mgr.store().delete(id).map_err(|e| e.to_string())
}
