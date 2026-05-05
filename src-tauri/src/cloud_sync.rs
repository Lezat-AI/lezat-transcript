//! Cloud Sync — sends meeting transcriptions to the Lezat Scheduling backend
//! and fetches action items, transcriptions, and integrations status.
//!
//! All requests are authenticated via `X-API-Key` header.
//! The backend is a Python FastAPI application with endpoints under `/api/desktop/*`.

use anyhow::{anyhow, Result};
use log::{info, warn};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::{Read as IoRead, Write as IoWrite};
use std::net::TcpListener;
use std::time::Duration;
use tauri_specta::Event;

use crate::managers::meeting::MeetingRecord;
use crate::settings::AppSettings;

// ─────────────────────────── events ───────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(tag = "state")]
pub enum CloudSyncEvent {
    #[serde(rename = "syncing")]
    Syncing { meeting_id: i64 },
    #[serde(rename = "success")]
    Success { meeting_id: i64, remote_id: String },
    #[serde(rename = "failed")]
    Failed { meeting_id: i64, error: String },
}

// ─────────────────────────── payloads ─────────────────────────────

#[derive(Debug, Serialize)]
struct DesktopMeetingPayload {
    device_id: String,
    local_meeting_id: i64,
    title: String,
    started_at: i64,
    ended_at: Option<i64>,
    duration_ms: i64,
    transcript_text: String,
    chunks: Vec<DesktopChunkPayload>,
    model_used: Option<String>,
    app_version: Option<String>,
    is_daily: bool,
    #[serde(default)]
    force_reprocess: bool,
}

#[derive(Debug, Serialize)]
struct DesktopChunkPayload {
    offset_ms: u64,
    source: String,
    text: String,
}

// ─────────────────────────── responses ────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct IngestResponse {
    pub status: String,
    pub stored_record_id: String,
    pub meeting_id: String,
    pub action_items_status: Option<String>,
    pub action_items_count: Option<i32>,
    pub suggested_title: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct CloudActionItem {
    pub id: String,
    pub meeting_id: Option<String>,
    pub meeting_title: Option<String>,
    pub description: Option<String>,
    pub assignee: Option<String>,
    pub due_date: Option<String>,
    #[serde(default = "default_task_type")]
    pub task_type: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub synced_to: Vec<String>,
    pub created_at: Option<String>,
}

fn default_task_type() -> String {
    "pending".to_string()
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct CloudActionItemsResponse {
    pub items: Vec<CloudActionItem>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct CloudTranscription {
    pub id: String,
    pub provider: String,
    pub meeting_id: Option<String>,
    pub meeting_title: Option<String>,
    pub meeting_platform: Option<String>,
    pub transcript_text_available: bool,
    pub transcript_text: Option<String>,
    pub participant_count: Option<i32>,
    pub received_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct CloudTranscriptionsResponse {
    pub items: Vec<CloudTranscription>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct IntegrationConfig {
    pub database_id: Option<String>,
    pub database_name: Option<String>,
    pub board_id: Option<String>,
    pub board_name: Option<String>,
    pub calendar_id: Option<String>,
    pub todo_status: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct IntegrationStatus {
    pub provider: String,
    pub connected: bool,
    pub workspace: Option<String>,
    pub account_name: Option<String>,
    pub config: Option<IntegrationConfig>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct IntegrationsStatusResponse {
    pub integrations: Vec<IntegrationStatus>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct NotionDatabase {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct MondayBoard {
    pub id: String,
    pub name: String,
}

// ─────────────────────────── daily reports ─────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct CompletedTask {
    pub description: String,
    pub source_sentence: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct PersonDailyReport {
    pub speaker_name: String,
    pub speaker_email: Option<String>,
    #[serde(default)]
    pub completed_tasks: Vec<CompletedTask>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct DailyReport {
    pub id: String,
    pub meeting_id: Option<String>,
    pub meeting_title: Option<String>,
    pub meeting_date: Option<String>,
    #[serde(default)]
    pub person_reports: Vec<PersonDailyReport>,
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct DailyReportsResponse {
    pub reports: Vec<DailyReport>,
}

// ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct OAuthConnectResponse {
    pub oauth_url: String,
    pub state: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct HealthResponse {
    pub status: String,
    pub user_email: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(tag = "state")]
pub enum GoogleLoginEvent {
    #[serde(rename = "success")]
    Success {
        user_email: String,
        user_name: String,
    },
    #[serde(rename = "failed")]
    Failed { error: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(tag = "state")]
pub enum IntegrationOAuthEvent {
    #[serde(rename = "success")]
    Success { provider: String },
    #[serde(rename = "failed")]
    Failed { provider: String, error: String },
}

// ─────────────────────────── auth ─────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct LoginUser {
    pub id: String,
    pub email: String,
    pub full_name: String,
    pub role: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct LoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in_seconds: i64,
    pub user: LoginUser,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct ApiKeyCreateResponse {
    pub id: String,
    pub key: String,
    pub key_prefix: String,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct CloudLoginResult {
    pub user_email: String,
    pub user_name: String,
    pub api_key: String,
}

// ─────────────────────────── client ──────────────────────────────

fn build_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| anyhow!("Failed to build HTTP client: {e}"))
}

fn base_url(settings: &AppSettings) -> Result<String> {
    settings
        .cloud_sync_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .map(|u| u.trim_end_matches('/').to_string())
        .ok_or_else(|| anyhow!("Cloud sync URL not configured"))
}

fn api_key(settings: &AppSettings) -> Result<&str> {
    settings
        .cloud_sync_api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("Cloud sync API key not configured"))
}

/// Send a meeting transcription to the backend. Retries up to 3 times
/// with exponential backoff on transient errors (network, 5xx).
pub fn sync_meeting_to_cloud(
    settings: &AppSettings,
    record: &MeetingRecord,
) -> Result<IngestResponse> {
    sync_meeting_to_cloud_inner(settings, record, false)
}

pub fn sync_meeting_to_cloud_force(
    settings: &AppSettings,
    record: &MeetingRecord,
) -> Result<IngestResponse> {
    sync_meeting_to_cloud_inner(settings, record, true)
}

fn sync_meeting_to_cloud_inner(
    settings: &AppSettings,
    record: &MeetingRecord,
    force_reprocess: bool,
) -> Result<IngestResponse> {
    let url = format!("{}/api/desktop/ingest", base_url(settings)?);
    let key = api_key(settings)?;

    let payload = DesktopMeetingPayload {
        device_id: settings.device_id.clone(),
        local_meeting_id: record.id,
        title: record.title.clone(),
        started_at: record.started_at,
        ended_at: record.ended_at,
        duration_ms: record.duration_ms,
        transcript_text: record.transcript_text.clone(),
        chunks: record
            .chunks
            .iter()
            .map(|c| DesktopChunkPayload {
                offset_ms: c.offset_ms,
                source: c.source.clone(),
                text: c.text.clone(),
            })
            .collect(),
        model_used: Some(settings.selected_model.clone()),
        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        is_daily: record.is_daily,
        force_reprocess,
    };

    let client = build_client()?;
    let backoff = [1, 3, 9]; // seconds

    for (attempt, delay_secs) in backoff.iter().enumerate() {
        let result = client
            .post(&url)
            .header("X-API-Key", key)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send();

        match result {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .json::<IngestResponse>()
                    .map_err(|e| anyhow!("Failed to parse ingest response: {e}"));
            }
            Ok(resp) if resp.status().as_u16() == 401 => {
                return Err(anyhow!("Invalid API key (HTTP 401)"));
            }
            Ok(resp) if resp.status().as_u16() == 422 => {
                let body = resp.text().unwrap_or_default();
                return Err(anyhow!("Validation error (HTTP 422): {body}"));
            }
            Ok(resp) if resp.status().is_server_error() => {
                let status = resp.status();
                let body = resp.text().unwrap_or_default();
                warn!(
                    "Cloud sync attempt {}/{}: server error {} — {body}",
                    attempt + 1,
                    backoff.len(),
                    status
                );
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().unwrap_or_default();
                return Err(anyhow!("Cloud sync failed (HTTP {status}): {body}"));
            }
            Err(e) => {
                warn!(
                    "Cloud sync attempt {}/{}: network error — {e}",
                    attempt + 1,
                    backoff.len()
                );
            }
        }

        if attempt < backoff.len() - 1 {
            std::thread::sleep(Duration::from_secs(*delay_secs));
        }
    }

    Err(anyhow!(
        "Cloud sync failed after {} attempts",
        backoff.len()
    ))
}

/// Fetch action items from the backend.
pub fn fetch_action_items(settings: &AppSettings) -> Result<CloudActionItemsResponse> {
    let url = format!("{}/api/desktop/action-items", base_url(settings)?);
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();

    if !status.is_success() {
        return Err(anyhow!(
            "Failed to fetch action items (HTTP {status}): {body}"
        ));
    }

    serde_json::from_str::<CloudActionItemsResponse>(&body).map_err(|e| {
        anyhow!(
            "Failed to parse action items: {e}\nBody: {}",
            &body[..body.len().min(500)]
        )
    })
}

/// Update an action item's status (and optionally other fields) on the backend.
pub fn update_action_item(
    settings: &AppSettings,
    item_id: &str,
    status: &str,
    edits: Option<serde_json::Value>,
) -> Result<()> {
    let url = format!(
        "{}/api/desktop/action-items/{}",
        base_url(settings)?,
        item_id
    );
    let key = api_key(settings)?;
    let client = build_client()?;

    let mut body = serde_json::json!({ "status": status });
    if let Some(extra) = edits {
        if let (Some(base), Some(obj)) = (body.as_object_mut(), extra.as_object()) {
            for (k, v) in obj {
                base.insert(k.clone(), v.clone());
            }
        }
    }

    let resp = client
        .patch(&url)
        .header("X-API-Key", key)
        .json(&body)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status_code = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!(
            "Failed to update action item (HTTP {status_code}): {body}"
        ));
    }

    Ok(())
}

/// Fetch transcriptions from the backend.
pub fn fetch_transcriptions(settings: &AppSettings) -> Result<CloudTranscriptionsResponse> {
    let url = format!("{}/api/desktop/transcriptions", base_url(settings)?);
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();

    if !status.is_success() {
        return Err(anyhow!(
            "Failed to fetch transcriptions (HTTP {status}): {body}"
        ));
    }

    serde_json::from_str::<CloudTranscriptionsResponse>(&body).map_err(|e| {
        anyhow!(
            "Failed to parse transcriptions: {e}\nBody: {}",
            &body[..body.len().min(500)]
        )
    })
}

/// Fetch integrations status from the backend.
pub fn fetch_integrations_status(settings: &AppSettings) -> Result<IntegrationsStatusResponse> {
    let url = format!("{}/api/desktop/integrations/status", base_url(settings)?);
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();

    if !status.is_success() {
        return Err(anyhow!(
            "Failed to fetch integrations (HTTP {status}): {body}"
        ));
    }

    serde_json::from_str::<IntegrationsStatusResponse>(&body).map_err(|e| {
        anyhow!(
            "Failed to parse integrations: {e}\nBody: {}",
            &body[..body.len().min(500)]
        )
    })
}

/// Poll the integrations status endpoint until the given provider is connected.
pub fn poll_integration_connected(
    settings: &AppSettings,
    provider: &str,
    poll_interval: Duration,
    timeout: Duration,
) -> Result<()> {
    let deadline = std::time::Instant::now() + timeout;

    loop {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!(
                "OAuth timed out after {} seconds",
                timeout.as_secs()
            ));
        }

        std::thread::sleep(poll_interval);

        match fetch_integrations_status(settings) {
            Ok(status_resp) => {
                if status_resp
                    .integrations
                    .iter()
                    .any(|i| i.provider == provider && i.connected)
                {
                    return Ok(());
                }
            }
            Err(e) => {
                warn!("Polling integrations status failed: {e}");
            }
        }
    }
}

/// Start an OAuth flow for a given provider. Returns the URL to open in the
/// system browser.
pub fn start_oauth_flow(
    settings: &AppSettings,
    provider: &str,
    desktop_redirect: Option<&str>,
) -> Result<OAuthConnectResponse> {
    let mut url = format!(
        "{}/api/desktop/integrations/{}/connect",
        base_url(settings)?,
        provider
    );
    if let Some(redirect) = desktop_redirect {
        url = format!("{}?desktop_redirect={}", url, urlencoding::encode(redirect));
    }
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .post(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!(
            "Failed to start OAuth flow (HTTP {status}): {body}"
        ));
    }

    resp.json::<OAuthConnectResponse>()
        .map_err(|e| anyhow!("Failed to parse OAuth response: {e}"))
}

/// Prepare a local TCP listener for integration OAuth callback (same pattern as Google OAuth).
/// Returns (oauth_url, listener).
pub fn integration_oauth_prepare(
    settings: &AppSettings,
    provider: &str,
) -> Result<(OAuthConnectResponse, TcpListener)> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| anyhow!("Failed to bind listener: {e}"))?;
    let port = listener.local_addr()?.port();
    let callback_url = format!("http://localhost:{port}/callback");

    let resp = start_oauth_flow(settings, provider, Some(&callback_url))?;

    Ok((resp, listener))
}

/// Wait on the TCP listener for the integration OAuth redirect (max 2 minutes).
/// Serves a "Connected!" HTML page when the callback arrives.
pub fn integration_oauth_wait(listener: &TcpListener) -> Result<()> {
    listener.set_nonblocking(true).ok();
    let deadline = std::time::Instant::now() + Duration::from_secs(120);

    let stream = loop {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!("OAuth timed out. Please try again."));
        }
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(anyhow!("Failed to accept connection: {e}")),
        }
    };

    stream.set_nonblocking(false).ok();
    serve_integration_success_html(stream)
}

/// Serve a simple "Connected!" HTML page for integration OAuth callbacks.
fn serve_integration_success_html(mut stream: std::net::TcpStream) -> Result<()> {
    let mut buf = [0u8; 4096];
    let _ = stream.read(&mut buf);

    let html = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Lezat Transcript</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex;
         align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #0d0d1a; color: #f5f5f5; }
  .card { text-align: center; padding: 2rem; }
  .success { color: #b8d4a3; }
</style></head>
<body><div class="card">
  <p class="success" style="font-size:1.5rem">&#10003;</p>
  <p class="success">Connected! You can close this tab.</p>
</div></body></html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    Ok(())
}

/// Disconnect an integration.
pub fn disconnect_integration(settings: &AppSettings, provider: &str) -> Result<()> {
    let url = format!(
        "{}/api/desktop/integrations/{}",
        base_url(settings)?,
        provider
    );
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .delete(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!(
            "Failed to disconnect integration (HTTP {status}): {body}"
        ));
    }

    Ok(())
}

/// Fetch Notion databases the user has access to.
pub fn fetch_notion_databases(settings: &AppSettings) -> Result<Vec<NotionDatabase>> {
    let url = format!(
        "{}/api/desktop/integrations/notion/databases",
        base_url(settings)?
    );
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;
    let body = resp.text().unwrap_or_default();

    // Backend returns list of {id, title, ...} dicts
    let raw: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap_or_default();
    Ok(raw
        .iter()
        .map(|v| NotionDatabase {
            id: v
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            name: v
                .get("title")
                .and_then(|v| v.as_str())
                .or_else(|| v.get("name").and_then(|v| v.as_str()))
                .unwrap_or("Untitled")
                .to_string(),
        })
        .collect())
}

/// Fetch Monday boards the user has access to.
pub fn fetch_monday_boards(settings: &AppSettings) -> Result<Vec<MondayBoard>> {
    let url = format!(
        "{}/api/desktop/integrations/monday/boards",
        base_url(settings)?
    );
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;
    let body = resp.text().unwrap_or_default();

    let raw: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap_or_default();
    Ok(raw
        .iter()
        .map(|v| MondayBoard {
            id: v
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            name: v
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string(),
        })
        .collect())
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct StatusOption {
    pub name: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct StatusOptionsResponse {
    #[serde(default)]
    pub options: Vec<StatusOption>,
}

/// Fetch status options for a Notion database.
pub fn fetch_notion_status_options(
    settings: &AppSettings,
    database_id: &str,
) -> Result<Vec<StatusOption>> {
    let url = format!(
        "{}/api/desktop/integrations/notion/databases/{}/status-options",
        base_url(settings)?,
        database_id
    );
    let key = api_key(settings)?;
    let client = build_client()?;
    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;
    let body = resp.text().unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    // Backend returns options as array of strings (e.g. ["Not started", "In progress", "Done"])
    let options = parsed
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    // Handle both string items and object items
                    if let Some(s) = v.as_str() {
                        Some(StatusOption {
                            name: s.to_string(),
                            color: String::new(),
                        })
                    } else if let Some(obj) = v.as_object() {
                        Some(StatusOption {
                            name: obj
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            color: obj
                                .get("color")
                                .and_then(|c| c.as_str())
                                .unwrap_or_default()
                                .to_string(),
                        })
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(options)
}

/// Fetch status options for a Monday board.
pub fn fetch_monday_status_options(
    settings: &AppSettings,
    board_id: &str,
) -> Result<Vec<StatusOption>> {
    let url = format!(
        "{}/api/desktop/integrations/monday/boards/{}/status-options",
        base_url(settings)?,
        board_id
    );
    let key = api_key(settings)?;
    let client = build_client()?;
    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;
    let body = resp.text().unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let options = parsed
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    if let Some(s) = v.as_str() {
                        Some(StatusOption {
                            name: s.to_string(),
                            color: String::new(),
                        })
                    } else if let Some(obj) = v.as_object() {
                        Some(StatusOption {
                            name: obj
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            color: obj
                                .get("color")
                                .and_then(|c| c.as_str())
                                .unwrap_or_default()
                                .to_string(),
                        })
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(options)
}

/// Fetch daily reports from the backend.
pub fn fetch_daily_reports(settings: &AppSettings) -> Result<DailyReportsResponse> {
    let url = format!("{}/api/desktop/daily-reports", base_url(settings)?);
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();

    if !status.is_success() {
        return Err(anyhow!(
            "Failed to fetch daily reports (HTTP {status}): {body}"
        ));
    }

    serde_json::from_str::<DailyReportsResponse>(&body).map_err(|e| {
        anyhow!(
            "Failed to parse daily reports: {e}\nBody: {}",
            &body[..body.len().min(500)]
        )
    })
}

/// Update integration settings on the backend.
pub fn update_integration_settings(
    settings: &AppSettings,
    values: std::collections::HashMap<String, String>,
) -> Result<()> {
    let url = format!("{}/api/desktop/integrations/settings", base_url(settings)?);
    let key = api_key(settings)?;
    let client = build_client()?;

    let resp = client
        .patch(&url)
        .header("X-API-Key", key)
        .json(&serde_json::json!({ "values": values }))
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!("Failed to update settings (HTTP {status}): {body}"));
    }
    Ok(())
}

/// Test the connection to the backend. Returns the health status.
pub fn test_connection(settings: &AppSettings) -> Result<HealthResponse> {
    let url = format!("{}/api/desktop/health", base_url(settings)?);
    let key = api_key(settings)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| anyhow!("Failed to build HTTP client: {e}"))?;

    let resp = client
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .map_err(|e| anyhow!("Connection failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!("Health check failed (HTTP {status}): {body}"));
    }

    resp.json::<HealthResponse>()
        .map_err(|e| anyhow!("Failed to parse health response: {e}"))
}

/// Login with email + password, then auto-create an API key.
/// Returns the user info and the API key ready to store in settings.
pub fn login_and_create_api_key(
    backend_url: &str,
    email: &str,
    password: &str,
) -> Result<CloudLoginResult> {
    let base = backend_url.trim_end_matches('/');
    let client = build_client()?;

    // Step 1: Login to get JWT
    let login_resp = client
        .post(format!("{base}/api/auth/login"))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
        }))
        .send()
        .map_err(|e| anyhow!("Connection failed: {e}"))?;

    if login_resp.status().as_u16() == 401 {
        return Err(anyhow!("Invalid email or password"));
    }
    if !login_resp.status().is_success() {
        let status = login_resp.status();
        let body = login_resp.text().unwrap_or_default();
        return Err(anyhow!("Login failed (HTTP {status}): {body}"));
    }

    let login_data: LoginResponse = login_resp
        .json()
        .map_err(|e| anyhow!("Failed to parse login response: {e}"))?;

    // Step 2: Create an API key using the JWT
    let key_resp = client
        .post(format!("{base}/api/auth/api-keys"))
        .header(
            "Authorization",
            format!("Bearer {}", login_data.access_token),
        )
        .json(&serde_json::json!({
            "label": "Lezat Transcript Desktop App",
        }))
        .send()
        .map_err(|e| anyhow!("Failed to create API key: {e}"))?;

    if !key_resp.status().is_success() {
        let status = key_resp.status();
        let body = key_resp.text().unwrap_or_default();
        return Err(anyhow!("API key creation failed (HTTP {status}): {body}"));
    }

    let key_data: ApiKeyCreateResponse = key_resp
        .json()
        .map_err(|e| anyhow!("Failed to parse API key response: {e}"))?;

    Ok(CloudLoginResult {
        user_email: login_data.user.email,
        user_name: login_data.user.full_name,
        api_key: key_data.key,
    })
}

/// Register with email + password + name, then auto-create an API key.
/// Returns the user info and the API key ready to store in settings.
pub fn register_and_create_api_key(
    backend_url: &str,
    email: &str,
    password: &str,
    full_name: &str,
) -> Result<CloudLoginResult> {
    let base = backend_url.trim_end_matches('/');
    let client = build_client()?;

    // Step 1: Register to get JWT
    let register_resp = client
        .post(format!("{base}/api/auth/register"))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "full_name": full_name,
        }))
        .send()
        .map_err(|e| anyhow!("Connection failed: {e}"))?;

    if register_resp.status().as_u16() == 409 {
        return Err(anyhow!("An account with this email already exists"));
    }
    if !register_resp.status().is_success() {
        let status = register_resp.status();
        let body = register_resp.text().unwrap_or_default();
        return Err(anyhow!("Registration failed (HTTP {status}): {body}"));
    }

    let login_data: LoginResponse = register_resp
        .json()
        .map_err(|e| anyhow!("Failed to parse register response: {e}"))?;

    // Step 2: Create an API key using the JWT
    let key_resp = client
        .post(format!("{base}/api/auth/api-keys"))
        .header(
            "Authorization",
            format!("Bearer {}", login_data.access_token),
        )
        .json(&serde_json::json!({
            "label": "Lezat Transcript Desktop App",
        }))
        .send()
        .map_err(|e| anyhow!("Failed to create API key: {e}"))?;

    if !key_resp.status().is_success() {
        let status = key_resp.status();
        let body = key_resp.text().unwrap_or_default();
        return Err(anyhow!("API key creation failed (HTTP {status}): {body}"));
    }

    let key_data: ApiKeyCreateResponse = key_resp
        .json()
        .map_err(|e| anyhow!("Failed to parse API key response: {e}"))?;

    Ok(CloudLoginResult {
        user_email: login_data.user.email,
        user_name: login_data.user.full_name,
        api_key: key_data.key,
    })
}

/// Returns (start_url, listener) so the Tauri command can open the browser
/// before we start waiting for the callback.
pub fn google_oauth_prepare(backend_url: &str) -> Result<(String, TcpListener)> {
    let base = backend_url.trim_end_matches('/');

    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| anyhow!("Failed to bind listener: {e}"))?;
    let port = listener.local_addr()?.port();

    let callback_url = format!("http://localhost:{port}/callback");
    let start_url = format!(
        "{base}/api/auth/google/start?desktop_redirect={}",
        urlencoding::encode(&callback_url)
    );

    Ok((start_url, listener))
}

/// Wait on the TCP listener for the OAuth callback (max 2 minutes).
pub fn google_oauth_wait(listener: &TcpListener) -> Result<CloudLoginResult> {
    // Use non-blocking mode with a polling loop so we have a timeout
    listener.set_nonblocking(true).ok();

    let deadline = std::time::Instant::now() + Duration::from_secs(120);

    // Wait for the first connection (the browser redirect)
    let first_stream = loop {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!("Google sign-in timed out. Please try again."));
        }
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(anyhow!("Failed to accept connection: {e}")),
        }
    };

    // Switch to blocking for actual I/O
    first_stream.set_nonblocking(false).ok();
    serve_oauth_html(first_stream)?;

    // Wait for the second connection (JavaScript callback with credentials)
    let second_stream = loop {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!(
                "Did not receive credentials from browser. Please try again."
            ));
        }
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(anyhow!("Failed to accept callback: {e}")),
        }
    };

    second_stream.set_nonblocking(false).ok();
    parse_oauth_credentials(second_stream)
}

/// Serve the HTML bridge page that reads the URL fragment and sends it back.
fn serve_oauth_html(mut stream: std::net::TcpStream) -> Result<()> {
    let mut buf = [0u8; 4096];
    let _ = stream.read(&mut buf);

    let html = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Lezat Transcript</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex;
         align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #0d0d1a; color: #f5f5f5; }
  .card { text-align: center; padding: 2rem; }
  .spinner { width: 24px; height: 24px; border: 3px solid #333;
             border-top-color: #b8d4a3; border-radius: 50%;
             animation: spin 0.8s linear infinite; margin: 1rem auto; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .success { color: #b8d4a3; }
</style></head>
<body><div class="card" id="card">
  <div class="spinner"></div>
  <p>Connecting to Lezat Transcript...</p>
</div>
<script>
  const frag = window.location.hash.substring(1);
  if (frag) {
    fetch('/oauth-complete?' + frag).then(() => {
      document.getElementById('card').innerHTML =
        '<p class="success" style="font-size:1.5rem">&#10003;</p>' +
        '<p class="success">Connected! You can close this tab.</p>';
    }).catch(() => {
      document.getElementById('card').innerHTML =
        '<p style="color:#f87171">Something went wrong. Please try again.</p>';
    });
  } else {
    document.getElementById('card').innerHTML =
      '<p style="color:#f87171">No credentials received. Please try again.</p>';
  }
</script></body></html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    Ok(())
}

/// Parse the credentials from the JavaScript callback request.
fn parse_oauth_credentials(mut stream: std::net::TcpStream) -> Result<CloudLoginResult> {
    let mut buf = [0u8; 8192];
    let n = stream
        .read(&mut buf)
        .map_err(|e| anyhow!("Failed to read callback: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse: GET /oauth-complete?api_key=...&email=...&name=... HTTP/1.1
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    // Send success response to the browser
    let ok_response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
    let _ = stream.write_all(ok_response.as_bytes());
    let _ = stream.flush();

    // Parse query params
    let query_str = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params: std::collections::HashMap<String, String> = query_str
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((
                urlencoding::decode(k).unwrap_or_default().into_owned(),
                urlencoding::decode(v).unwrap_or_default().into_owned(),
            ))
        })
        .collect();

    let api_key = params
        .get("api_key")
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("No API key received from Google sign-in"))?
        .clone();
    let user_email = params.get("email").cloned().unwrap_or_default();
    let user_name = params.get("name").cloned().unwrap_or_default();

    info!("Google OAuth: received API key for {user_email}");

    Ok(CloudLoginResult {
        user_email,
        user_name,
        api_key,
    })
}

// ─────────────────────────── AI suggestions ─────────────────────────

/// Ask the scheduling backend to generate a timesheet suggestion from task descriptions.
pub fn ai_suggest_timesheet(
    settings: &AppSettings,
    task_descriptions: &[String],
    projects_json: &str,
) -> Result<serde_json::Value> {
    let url = format!("{}/api/desktop/ai/suggest-timesheet", base_url(settings)?);
    let key = api_key(settings)?;
    let client = build_client()?;

    let payload = serde_json::json!({
        "task_descriptions": task_descriptions,
        "projects": serde_json::from_str::<serde_json::Value>(projects_json).unwrap_or_default(),
    });

    let resp = client
        .post(&url)
        .header("X-API-Key", key)
        .json(&payload)
        .send()
        .map_err(|e| anyhow!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!("AI suggest failed (HTTP {status}): {body}"));
    }

    let body = resp.text()?;
    serde_json::from_str(&body).map_err(|e| anyhow!("Invalid JSON from AI suggest: {e}"))
}
