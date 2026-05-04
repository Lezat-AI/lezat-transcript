//! Timesheet integration — connects to the Lezat Timesheet backend
//! for logging work hours from within the desktop app.
//!
//! Auth: email/password → Bearer token (stored in settings).
//! API base: configurable, defaults to https://timesheet.back.lezat.tech

use anyhow::{anyhow, Result};
use log::info;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

use crate::settings::AppSettings;

// ─────────────────────────── response types ─────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct TimesheetLoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub user: Option<TimesheetUser>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct TimesheetUser {
    pub id: String,
    pub email: String,
    pub full_name: String,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Serialize, Clone, Type)]
pub struct TimesheetProject {
    pub id: i64,
    pub name: String,
    pub client_name: String,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Type)]
pub struct TimesheetEntry {
    pub id: i64,
    pub project_id: i64,
    pub date: String,
    pub hours: String,
    pub description: String,
    pub user_id: i64,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
struct LoginPayload {
    email: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct CreateTimeEntryPayload {
    project_id: i64,
    date: String,
    hours: f64,
    description: String,
}

// ─────────────────────────── helpers ────────────────────────────────

fn build_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("Failed to build HTTP client")
}

fn base_url(settings: &AppSettings) -> String {
    let url = settings.timesheet_url.trim_end_matches('/').to_string();
    if url.is_empty() {
        "https://timesheet.back.lezat.tech".to_string()
    } else {
        url
    }
}

fn token(settings: &AppSettings) -> Result<String> {
    settings
        .timesheet_token
        .as_ref()
        .filter(|t| !t.is_empty())
        .cloned()
        .ok_or_else(|| anyhow!("Not logged in to Timesheet"))
}

/// Parse a user JSON value that may use firstName/lastName or full_name.
fn parse_user_value(val: &serde_json::Value) -> Option<TimesheetUser> {
    // Try direct deserialization first (has full_name)
    if let Ok(u) = serde_json::from_value::<TimesheetUser>(val.clone()) {
        return Some(u);
    }

    // Fallback: build from firstName + lastName
    let id = val.get("id").map(|v| match v {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        _ => v.to_string(),
    })?;
    let email = val.get("email").and_then(|v| v.as_str())?.to_string();
    let first = val.get("firstName").and_then(|v| v.as_str()).unwrap_or("");
    let last = val.get("lastName").and_then(|v| v.as_str()).unwrap_or("");
    let full_name = format!("{} {}", first, last).trim().to_string();
    let role = val.get("role").and_then(|v| v.as_str()).map(String::from);

    Some(TimesheetUser {
        id,
        email,
        full_name,
        role,
    })
}

/// Parse a project JSON value that may use client_name or clientName.
fn parse_project_value(val: &serde_json::Value) -> Option<TimesheetProject> {
    let id = val.get("id").and_then(|v| match v {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.parse::<i64>().ok(),
        _ => None,
    })?;
    let name = val.get("name").and_then(|v| v.as_str())?.to_string();
    let client_name = val
        .get("client_name")
        .or_else(|| val.get("clientName"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let status = val.get("status").and_then(|v| v.as_str()).map(String::from);

    Some(TimesheetProject {
        id,
        name,
        client_name,
        status,
    })
}

// ─────────────────────────── API functions ──────────────────────────

/// Authenticate with email+password, return the login response with token.
pub fn login(
    settings: &AppSettings,
    email: &str,
    password: &str,
) -> Result<TimesheetLoginResponse> {
    let client = build_client();
    let url = format!("{}/auth/login", base_url(settings));

    let resp = client
        .post(&url)
        .json(&LoginPayload {
            email: email.to_string(),
            password: password.to_string(),
        })
        .send()?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!("Login failed ({}): {}", status, body));
    }

    // Parse the raw JSON first — the response schema is undocumented so we
    // need to handle various shapes flexibly.
    let body = resp.text()?;
    let raw: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow!("Invalid JSON from login: {e} — body: {body}"))?;

    // The actual API returns: { data: { user: {...}, token: "..." }, success: true }
    let data = raw.get("data").unwrap_or(&raw);

    // Extract token — try data.token, data.access_token, root.access_token
    let access_token = data
        .get("token")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("access_token").and_then(|v| v.as_str()))
        .or_else(|| raw.get("access_token").and_then(|v| v.as_str()))
        .ok_or_else(|| anyhow!("No token in login response: {body}"))?
        .to_string();

    let token_type = data
        .get("token_type")
        .and_then(|v| v.as_str())
        .unwrap_or("bearer")
        .to_string();

    // Try to extract inline user data — API uses firstName/lastName
    let user = data
        .get("user")
        .or_else(|| raw.get("user"))
        .and_then(|u| parse_user_value(u));

    let mut login_resp = TimesheetLoginResponse {
        access_token,
        token_type,
        user,
    };

    // If the response doesn't include user info, fetch it separately
    if login_resp.user.is_none() {
        if let Ok(u) = get_me_with_token(settings, &login_resp.access_token) {
            login_resp.user = Some(u);
        }
    }

    info!("Timesheet login successful for {}", email);
    Ok(login_resp)
}

/// Get the current user profile using a specific token.
fn get_me_with_token(settings: &AppSettings, access_token: &str) -> Result<TimesheetUser> {
    let client = build_client();
    let url = format!("{}/auth/me", base_url(settings));

    let resp = client.get(&url).bearer_auth(access_token).send()?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!("Failed to get user profile ({}): {}", status, body));
    }

    let body = resp.text()?;
    let raw: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow!("Invalid JSON from /auth/me: {e} — body: {body}"))?;

    // The user data might be at root level or nested under "data" / "user"
    let user_val = if raw.get("id").is_some() {
        &raw
    } else if let Some(inner) = raw.get("data").or_else(|| raw.get("user")) {
        inner
    } else {
        &raw
    };

    parse_user_value(user_val).ok_or_else(|| anyhow!("Cannot parse user from /auth/me: {body}"))
}

/// Check if the stored token is still valid by calling /auth/me.
pub fn check_connection(settings: &AppSettings) -> Result<TimesheetUser> {
    let t = token(settings)?;
    get_me_with_token(settings, &t)
}

/// Fetch all projects (paginated, returns first page of 100).
pub fn get_projects(settings: &AppSettings) -> Result<Vec<TimesheetProject>> {
    let t = token(settings)?;
    let client = build_client();
    let url = format!("{}/projects/", base_url(settings));

    let resp = client
        .get(&url)
        .bearer_auth(&t)
        .query(&[("page", "1"), ("limit", "100"), ("active_only", "false")])
        .send()?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(anyhow!("session_expired"));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!("Failed to fetch projects ({}): {}", status, body));
    }

    let body = resp.text()?;
    let raw: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| anyhow!("Invalid JSON from /projects: {e}"))?;

    // Unwrap nested response. Actual shape:
    // { data: { data: [...], pagination: {...} }, success: true }
    // but also handle { data: [...] }, { items: [...] }, or [...]
    let outer = raw.get("data").unwrap_or(&raw);
    let items_val = if let Some(inner) = outer.get("data").filter(|v| v.is_array()) {
        inner
    } else if let Some(items) = outer.get("items") {
        items
    } else if outer.is_array() {
        outer
    } else if let Some(items) = raw.get("items") {
        items
    } else if raw.is_array() {
        &raw
    } else {
        return Err(anyhow!("Unexpected projects response: {body}"));
    };

    let arr = items_val
        .as_array()
        .ok_or_else(|| anyhow!("Projects is not an array: {body}"))?;

    let projects: Vec<TimesheetProject> = arr.iter().filter_map(parse_project_value).collect();

    if projects.is_empty() && !arr.is_empty() {
        return Err(anyhow!("Could not parse any project from response: {body}"));
    }

    Ok(projects)
}

/// Create a new time entry.
pub fn create_time_entry(
    settings: &AppSettings,
    project_id: i64,
    date: &str,
    hours: f64,
    description: &str,
) -> Result<TimesheetEntry> {
    let t = token(settings)?;
    let client = build_client();
    let url = format!("{}/time-entries/", base_url(settings));

    let payload = CreateTimeEntryPayload {
        project_id,
        date: date.to_string(),
        hours,
        description: description.to_string(),
    };

    let resp = client.post(&url).bearer_auth(&t).json(&payload).send()?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(anyhow!("session_expired"));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!(
            "Failed to create time entry ({}): {}",
            status,
            body
        ));
    }

    let body = resp.text()?;
    let raw: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow!("Cannot parse time entry response: {e} — body: {body}"))?;

    // API wraps the entry in { data: { ... }, success: true }
    let data = raw.get("data").unwrap_or(&raw);

    // hours may come as a number — coerce to string for our struct
    let mut entry_val = data.clone();
    if let Some(obj) = entry_val.as_object_mut() {
        if let Some(h) = obj.get("hours").and_then(|v| v.as_f64()) {
            obj.insert(
                "hours".to_string(),
                serde_json::Value::String(format!("{:.2}", h)),
            );
        }
    }

    let entry: TimesheetEntry = serde_json::from_value(entry_val)
        .map_err(|e| anyhow!("Cannot parse time entry response: {e} — body: {body}"))?;

    info!(
        "Created timesheet entry: {} hours on project {} for {}",
        entry.hours, project_id, date
    );
    Ok(entry)
}

/// Fetch a single time entry by ID.
pub fn get_time_entry(settings: &AppSettings, entry_id: i64) -> Result<TimesheetEntry> {
    let t = token(settings)?;
    let client = build_client();
    let url = format!("{}/time-entries/{}", base_url(settings), entry_id);

    let resp = client.get(&url).bearer_auth(&t).send()?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(anyhow!("session_expired"));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!("Failed to fetch time entry ({}): {}", status, body));
    }

    let body = resp.text()?;
    let raw: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow!("Cannot parse time entry response: {e} — body: {body}"))?;

    let data = raw.get("data").unwrap_or(&raw);

    let mut entry_val = data.clone();
    if let Some(obj) = entry_val.as_object_mut() {
        if let Some(h) = obj.get("hours").and_then(|v| v.as_f64()) {
            obj.insert(
                "hours".to_string(),
                serde_json::Value::String(format!("{:.2}", h)),
            );
        }
    }

    serde_json::from_value(entry_val)
        .map_err(|e| anyhow!("Cannot parse time entry: {e} — body: {body}"))
}

/// Delete a time entry by ID.
pub fn delete_time_entry(settings: &AppSettings, entry_id: i64) -> Result<()> {
    let t = token(settings)?;
    let client = build_client();
    let url = format!("{}/time-entries/{}", base_url(settings), entry_id);

    let resp = client.delete(&url).bearer_auth(&t).send()?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(anyhow!("session_expired"));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!(
            "Failed to delete time entry ({}): {}",
            status,
            body
        ));
    }

    info!("Deleted timesheet entry {}", entry_id);
    Ok(())
}

/// Update an existing time entry.
pub fn update_time_entry(
    settings: &AppSettings,
    entry_id: i64,
    project_id: i64,
    date: &str,
    hours: f64,
    description: &str,
) -> Result<TimesheetEntry> {
    let t = token(settings)?;
    let client = build_client();
    let url = format!("{}/time-entries/{}", base_url(settings), entry_id);

    let payload = CreateTimeEntryPayload {
        project_id,
        date: date.to_string(),
        hours,
        description: description.to_string(),
    };

    let resp = client.put(&url).bearer_auth(&t).json(&payload).send()?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(anyhow!("session_expired"));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(anyhow!(
            "Failed to update time entry ({}): {}",
            status,
            body
        ));
    }

    let body = resp.text()?;
    let raw: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow!("Cannot parse time entry response: {e} — body: {body}"))?;

    let data = raw.get("data").unwrap_or(&raw);

    let mut entry_val = data.clone();
    if let Some(obj) = entry_val.as_object_mut() {
        if let Some(h) = obj.get("hours").and_then(|v| v.as_f64()) {
            obj.insert(
                "hours".to_string(),
                serde_json::Value::String(format!("{:.2}", h)),
            );
        }
    }

    let entry: TimesheetEntry = serde_json::from_value(entry_val)
        .map_err(|e| anyhow!("Cannot parse time entry response: {e} — body: {body}"))?;

    info!(
        "Updated timesheet entry {} — {} hours on project {} for {}",
        entry_id, entry.hours, project_id, date
    );
    Ok(entry)
}
