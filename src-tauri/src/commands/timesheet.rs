//! Tauri commands for the Lezat Timesheet integration.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::settings;
use crate::timesheet;

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct TimesheetAiSuggestion {
    pub project_id: Option<i64>,
    pub hours: Option<f64>,
    pub description: Option<String>,
}

/// Try to re-login using stored credentials. Returns new token on success.
async fn try_auto_relogin(app: &AppHandle) -> Option<String> {
    let s = settings::get_settings(app);
    let email = s.timesheet_email.clone()?;
    let password = s.timesheet_password.clone()?;

    log::info!("Timesheet token expired, attempting auto re-login for {email}");

    let s_clone = s.clone();
    let result = tokio::task::spawn_blocking(move || timesheet::login(&s_clone, &email, &password))
        .await
        .ok()?
        .ok()?;

    log::info!("Timesheet auto re-login successful");
    Some(result.access_token)
}

/// Login to the Timesheet backend and store the token + credentials in settings.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_login(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<timesheet::TimesheetLoginResponse, String> {
    let s = settings::get_settings(&app);
    let app_clone = app.clone();
    let email_clone = email.clone();
    let password_clone = password.clone();

    let result = tokio::task::spawn_blocking(move || {
        timesheet::login(&s, &email_clone, &password_clone).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Persist token, email and password (for auto re-auth on token expiry)
    let mut s = settings::get_settings(&app_clone);
    s.timesheet_token = Some(result.access_token.clone());
    s.timesheet_email = Some(
        result
            .user
            .as_ref()
            .map(|u| u.email.clone())
            .unwrap_or_default(),
    );
    s.timesheet_password = Some(password);
    settings::write_settings(&app_clone, s);

    Ok(result)
}

/// Disconnect from Timesheet (clear token from settings).
#[tauri::command]
#[specta::specta]
pub async fn timesheet_disconnect(app: AppHandle) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.timesheet_token = None;
    s.timesheet_email = None;
    s.timesheet_password = None;
    s.timesheet_default_project_id = None;
    settings::write_settings(&app, s);
    Ok(())
}

/// Check if the stored token is still valid.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_get_status(app: AppHandle) -> Result<timesheet::TimesheetUser, String> {
    let s = settings::get_settings(&app);
    tokio::task::spawn_blocking(move || timesheet::check_connection(&s).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Fetch projects from the Timesheet backend, with automatic token renewal on 401.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_get_projects(
    app: AppHandle,
) -> Result<Vec<timesheet::TimesheetProject>, String> {
    let s = settings::get_settings(&app);
    let result = tokio::task::spawn_blocking({
        let s = s.clone();
        move || timesheet::get_projects(&s)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(projects) => Ok(projects),
        Err(e) if e.to_string().contains("session_expired") => {
            // Try auto re-login with stored credentials
            if let Some(new_token) = try_auto_relogin(&app).await {
                let mut s2 = settings::get_settings(&app);
                s2.timesheet_token = Some(new_token);
                settings::write_settings(&app, s2.clone());
                // Retry with fresh token
                tokio::task::spawn_blocking(move || {
                    timesheet::get_projects(&s2).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            } else {
                Err("session_expired".to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Save the default project ID in settings.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_set_default_project(
    app: AppHandle,
    project_id: Option<i64>,
) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.timesheet_default_project_id = project_id;
    settings::write_settings(&app, s);
    Ok(())
}

/// Create a new time entry, with automatic token renewal on 401.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_create_entry(
    app: AppHandle,
    project_id: i64,
    date: String,
    hours: f64,
    description: String,
) -> Result<timesheet::TimesheetEntry, String> {
    let s = settings::get_settings(&app);
    let d = date.clone();
    let desc = description.clone();
    let result = tokio::task::spawn_blocking(move || {
        timesheet::create_time_entry(&s, project_id, &d, hours, &desc)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(entry) => Ok(entry),
        Err(e) if e.to_string().contains("session_expired") => {
            if let Some(new_token) = try_auto_relogin(&app).await {
                let mut s2 = settings::get_settings(&app);
                s2.timesheet_token = Some(new_token);
                settings::write_settings(&app, s2.clone());
                tokio::task::spawn_blocking(move || {
                    timesheet::create_time_entry(&s2, project_id, &date, hours, &description)
                        .map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            } else {
                Err("session_expired".to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Fetch a single time entry by ID, with automatic token renewal.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_get_entry(
    app: AppHandle,
    entry_id: i64,
) -> Result<timesheet::TimesheetEntry, String> {
    let s = settings::get_settings(&app);
    let result = tokio::task::spawn_blocking(move || timesheet::get_time_entry(&s, entry_id))
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(entry) => Ok(entry),
        Err(e) if e.to_string().contains("session_expired") => {
            if let Some(new_token) = try_auto_relogin(&app).await {
                let mut s2 = settings::get_settings(&app);
                s2.timesheet_token = Some(new_token);
                settings::write_settings(&app, s2.clone());
                tokio::task::spawn_blocking(move || {
                    timesheet::get_time_entry(&s2, entry_id).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            } else {
                Err("session_expired".to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a time entry by ID, with automatic token renewal.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_delete_entry(app: AppHandle, entry_id: i64) -> Result<(), String> {
    let s = settings::get_settings(&app);
    let result = tokio::task::spawn_blocking(move || timesheet::delete_time_entry(&s, entry_id))
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(()) => Ok(()),
        Err(e) if e.to_string().contains("session_expired") => {
            if let Some(new_token) = try_auto_relogin(&app).await {
                let mut s2 = settings::get_settings(&app);
                s2.timesheet_token = Some(new_token);
                settings::write_settings(&app, s2.clone());
                tokio::task::spawn_blocking(move || {
                    timesheet::delete_time_entry(&s2, entry_id).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            } else {
                Err("session_expired".to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Update an existing time entry, with automatic token renewal.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_update_entry(
    app: AppHandle,
    entry_id: i64,
    project_id: i64,
    date: String,
    hours: f64,
    description: String,
) -> Result<timesheet::TimesheetEntry, String> {
    let s = settings::get_settings(&app);
    let d = date.clone();
    let desc = description.clone();
    let result = tokio::task::spawn_blocking(move || {
        timesheet::update_time_entry(&s, entry_id, project_id, &d, hours, &desc)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(entry) => Ok(entry),
        Err(e) if e.to_string().contains("session_expired") => {
            if let Some(new_token) = try_auto_relogin(&app).await {
                let mut s2 = settings::get_settings(&app);
                s2.timesheet_token = Some(new_token);
                settings::write_settings(&app, s2.clone());
                tokio::task::spawn_blocking(move || {
                    timesheet::update_time_entry(
                        &s2,
                        entry_id,
                        project_id,
                        &date,
                        hours,
                        &description,
                    )
                    .map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            } else {
                Err("session_expired".to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Get the task→entry mapping from settings.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_get_task_entries(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, i64>, String> {
    let s = settings::get_settings(&app);
    Ok(s.timesheet_task_entries)
}

/// Save task→entry links into settings (merges with existing).
#[tauri::command]
#[specta::specta]
pub async fn timesheet_save_task_entries(
    app: AppHandle,
    entries: std::collections::HashMap<String, i64>,
) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.timesheet_task_entries.extend(entries);
    settings::write_settings(&app, s);
    Ok(())
}

/// Remove a task→entry link from settings.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_remove_task_entry(app: AppHandle, task_id: String) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.timesheet_task_entries.remove(&task_id);
    settings::write_settings(&app, s);
    Ok(())
}

/// Remove all task→entry links that point to a given entry ID.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_remove_entry_tasks(app: AppHandle, entry_id: i64) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.timesheet_task_entries.retain(|_, v| *v != entry_id);
    settings::write_settings(&app, s);
    Ok(())
}

/// Suggest timesheet fields from task descriptions using the Lezat Scheduling
/// backend AI. Falls back to the user's local LLM config if cloud is unavailable.
#[tauri::command]
#[specta::specta]
pub async fn timesheet_ai_suggest(
    app: AppHandle,
    task_descriptions: Vec<String>,
    projects_json: String,
) -> Result<TimesheetAiSuggestion, String> {
    let s = settings::get_settings(&app);
    let descs = task_descriptions.clone();
    let pjson = projects_json.clone();

    // Strategy 1: Use the Lezat Scheduling backend (no user config needed)
    let cloud_result = tokio::task::spawn_blocking(move || {
        crate::cloud_sync::ai_suggest_timesheet(&s, &descs, &pjson)
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Ok(raw) = cloud_result {
        // The backend may return { data: { ... } } or { project_id, hours, description } directly
        let suggestion_val = raw.get("data").unwrap_or(&raw);
        if let Ok(suggestion) =
            serde_json::from_value::<TimesheetAiSuggestion>(suggestion_val.clone())
        {
            return Ok(suggestion);
        }
    }

    // Strategy 2: Fall back to user's local LLM config
    let s = settings::get_settings(&app);
    let provider = match s.active_post_process_provider().cloned() {
        Some(p) => p,
        None => return Err("AI not available. The cloud backend did not respond and no local AI provider is configured.".to_string()),
    };

    let model = s
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if model.trim().is_empty() {
        return Err("AI not available. No model configured.".to_string());
    }

    let api_key = s
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if api_key.trim().is_empty() {
        return Err("AI not available. No API key configured.".to_string());
    }

    let tasks_text = task_descriptions
        .iter()
        .enumerate()
        .map(|(i, d)| format!("{}. {}", i + 1, d))
        .collect::<Vec<_>>()
        .join("\n");

    let system_prompt = "You are a helpful assistant that analyzes meeting task descriptions and suggests timesheet entries. \
        You must respond with ONLY a valid JSON object (no markdown, no explanation) with these fields:\n\
        - \"project_id\": (number or null) the ID of the most relevant project from the provided list\n\
        - \"hours\": (number or null) estimated hours as a decimal (e.g. 1.5 for 1h30m), be reasonable\n\
        - \"description\": (string or null) a concise summary of the work done, based on the tasks\n\
        Be practical and concise. The description should be a professional timesheet entry.".to_string();

    let user_content = format!(
        "Tasks from the meeting:\n{}\n\nAvailable projects:\n{}\n\nSuggest a timesheet entry for these tasks.",
        tasks_text, projects_json
    );

    let result = crate::llm_client::send_chat_completion_with_schema(
        &provider,
        api_key,
        &model,
        user_content,
        Some(system_prompt),
        None,
        None,
        None,
    )
    .await
    .map_err(|e| format!("AI request failed: {e}"))?;

    let text = result.ok_or_else(|| "AI returned empty response".to_string())?;

    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    serde_json::from_str::<TimesheetAiSuggestion>(cleaned)
        .map_err(|e| format!("Could not parse AI suggestion: {e} — raw: {cleaned}"))
}
