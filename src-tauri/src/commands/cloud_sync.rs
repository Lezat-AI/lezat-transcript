//! Tauri commands for cloud sync with the Lezat Scheduling backend.

use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

use crate::cloud_sync;
use crate::managers::meeting::MeetingManager;
use crate::settings;

#[tauri::command]
#[specta::specta]
pub fn cloud_sync_meeting(app: AppHandle, meeting_id: i64) -> Result<(), String> {
    let mgr = app
        .try_state::<Arc<MeetingManager>>()
        .ok_or_else(|| "MeetingManager not initialized".to_string())?;

    let record = mgr
        .store()
        .get(meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Meeting {meeting_id} not found"))?;

    let s = settings::get_settings(&app);

    // Run in a background thread to avoid blocking the UI.
    std::thread::spawn(move || {
        let _ = (cloud_sync::CloudSyncEvent::Syncing { meeting_id }).emit(&app);

        // Manual sync always forces re-processing so updated prompts take effect.
        match cloud_sync::sync_meeting_to_cloud_force(&s, &record) {
            Ok(resp) => {
                // Auto-rename meeting if the backend suggested a title.
                if let Some(ref title) = resp.suggested_title {
                    if let Some(mgr) = app.try_state::<Arc<MeetingManager>>() {
                        if let Err(e) = mgr.store().rename(meeting_id, title) {
                            log::warn!("Failed to apply suggested title: {e}");
                        }
                    }
                }

                let _ = (cloud_sync::CloudSyncEvent::Success {
                    meeting_id,
                    remote_id: resp.stored_record_id,
                })
                .emit(&app);
            }
            Err(e) => {
                let _ = (cloud_sync::CloudSyncEvent::Failed {
                    meeting_id,
                    error: e.to_string(),
                })
                .emit(&app);
            }
        }
    });

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_test_connection(app: AppHandle) -> Result<cloud_sync::HealthResponse, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || cloud_sync::test_connection(&s).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_action_items(
    app: AppHandle,
) -> Result<cloud_sync::CloudActionItemsResponse, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_action_items(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_update_action_item(
    app: AppHandle,
    item_id: String,
    status: String,
    edits_json: Option<String>,
) -> Result<(), String> {
    let s = settings::get_settings(&app);
    let edits = edits_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    tokio::task::spawn_blocking(move || {
        cloud_sync::update_action_item(&s, &item_id, &status, edits).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_transcriptions(
    app: AppHandle,
) -> Result<cloud_sync::CloudTranscriptionsResponse, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_transcriptions(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_integrations_status(
    app: AppHandle,
) -> Result<cloud_sync::IntegrationsStatusResponse, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_integrations_status(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub fn cloud_start_integration_oauth(
    app: AppHandle,
    provider: String,
) -> Result<cloud_sync::OAuthConnectResponse, String> {
    let s = settings::get_settings(&app);

    // Prepare a local TCP listener so the backend can redirect back to the desktop
    // after the OAuth flow completes (same pattern as Google OAuth).
    let (resp, listener) =
        cloud_sync::integration_oauth_prepare(&s, &provider).map_err(|e| e.to_string())?;

    // Open the OAuth URL in the system browser
    if let Err(e) = app.opener().open_url(&resp.oauth_url, None::<String>) {
        log::warn!("Failed to open OAuth URL in browser: {e}");
    }

    // Wait for OAuth redirect on the local listener + poll backend as fallback
    let poll_provider = provider.clone();
    std::thread::spawn(move || {
        let s = settings::get_settings(&app);

        // Wait for the browser redirect to our local listener (shows "Connected!" page)
        let listener_ok = cloud_sync::integration_oauth_wait(&listener).is_ok();

        // Also poll the backend to confirm the integration is actually connected
        match cloud_sync::poll_integration_connected(
            &s,
            &poll_provider,
            std::time::Duration::from_secs(2),
            // If we already got the redirect, give the backend just a short window
            if listener_ok {
                std::time::Duration::from_secs(15)
            } else {
                std::time::Duration::from_secs(120)
            },
        ) {
            Ok(()) => {
                let _ = (cloud_sync::IntegrationOAuthEvent::Success {
                    provider: poll_provider,
                })
                .emit(&app);
            }
            Err(e) => {
                // If the listener got the redirect, still consider it a success
                // (the backend may just be slow to update status)
                if listener_ok {
                    let _ = (cloud_sync::IntegrationOAuthEvent::Success {
                        provider: poll_provider,
                    })
                    .emit(&app);
                } else {
                    let _ = (cloud_sync::IntegrationOAuthEvent::Failed {
                        provider: poll_provider,
                        error: e.to_string(),
                    })
                    .emit(&app);
                }
            }
        }
    });

    Ok(resp)
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_disconnect_integration(app: AppHandle, provider: String) -> Result<(), String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::disconnect_integration(&s, &provider).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Login with email + password, auto-create API key, and save everything to settings.
#[tauri::command]
#[specta::specta]
pub async fn cloud_login(
    app: AppHandle,
    backend_url: String,
    email: String,
    password: String,
) -> Result<cloud_sync::CloudLoginResult, String> {
    let app_clone = app.clone();
    let url = backend_url.clone();
    let result = tokio::task::spawn_blocking(move || {
        cloud_sync::login_and_create_api_key(&url, &email, &password).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Save URL + API key to settings automatically
    let mut s = settings::get_settings(&app_clone);
    s.cloud_sync_url = Some(backend_url);
    s.cloud_sync_api_key = Some(result.api_key.clone());
    s.cloud_sync_enabled = true;
    settings::write_settings(&app_clone, s);

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_daily_reports(
    app: AppHandle,
) -> Result<cloud_sync::DailyReportsResponse, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_daily_reports(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_notion_databases(
    app: AppHandle,
) -> Result<Vec<cloud_sync::NotionDatabase>, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_notion_databases(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_monday_boards(
    app: AppHandle,
) -> Result<Vec<cloud_sync::MondayBoard>, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_monday_boards(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_notion_status_options(
    app: AppHandle,
    database_id: String,
) -> Result<Vec<cloud_sync::StatusOption>, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_notion_status_options(&s, &database_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_monday_status_options(
    app: AppHandle,
    board_id: String,
) -> Result<Vec<cloud_sync::StatusOption>, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::fetch_monday_status_options(&s, &board_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_update_integration_settings(
    app: AppHandle,
    values: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || {
        cloud_sync::update_integration_settings(&s, values).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Register with email + password + name, auto-create API key, and save everything to settings.
#[tauri::command]
#[specta::specta]
pub async fn cloud_register(
    app: AppHandle,
    backend_url: String,
    email: String,
    password: String,
    full_name: String,
) -> Result<cloud_sync::CloudLoginResult, String> {
    let app_clone = app.clone();
    let url = backend_url.clone();
    let result = tokio::task::spawn_blocking(move || {
        cloud_sync::register_and_create_api_key(&url, &email, &password, &full_name)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Save URL + API key to settings automatically
    let mut s = settings::get_settings(&app_clone);
    s.cloud_sync_url = Some(backend_url);
    s.cloud_sync_api_key = Some(result.api_key.clone());
    s.cloud_sync_enabled = true;
    settings::write_settings(&app_clone, s);

    Ok(result)
}

/// Login with Google OAuth. Opens the system browser, waits for the callback
/// in a background thread, and emits a GoogleLoginEvent when done.
/// Returns immediately so the UI doesn't freeze.
#[tauri::command]
#[specta::specta]
pub fn cloud_login_google(app: AppHandle, backend_url: String) -> Result<(), String> {
    // Prepare the OAuth flow (binds a localhost server)
    let (start_url, listener) =
        cloud_sync::google_oauth_prepare(&backend_url).map_err(|e| e.to_string())?;

    // Open the browser
    if let Err(e) = app.opener().open_url(&start_url, None::<String>) {
        return Err(format!("Failed to open browser: {e}"));
    }

    // Wait in a background thread — emit event when done
    std::thread::spawn(move || {
        match cloud_sync::google_oauth_wait(&listener) {
            Ok(result) => {
                // Save URL + API key to settings
                let mut s = settings::get_settings(&app);
                s.cloud_sync_url = Some(backend_url);
                s.cloud_sync_api_key = Some(result.api_key.clone());
                s.cloud_sync_enabled = true;
                settings::write_settings(&app, s);

                let _ = (cloud_sync::GoogleLoginEvent::Success {
                    user_email: result.user_email,
                    user_name: result.user_name,
                })
                .emit(&app);
            }
            Err(e) => {
                let _ = (cloud_sync::GoogleLoginEvent::Failed {
                    error: e.to_string(),
                })
                .emit(&app);
            }
        }
    });

    Ok(())
}
