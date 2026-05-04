//! Cloud Transcription — sends audio to the Lezat Scheduling backend
//! for server-side ASR (Gemini). The backend handles provider selection.
//!
//! Reuses the same authentication (`X-API-Key`) and base URL as `cloud_sync`.

use anyhow::{anyhow, Result};
use log::{debug, info, warn};
use reqwest::blocking::Client;
use serde::Deserialize;
use std::io::Cursor;
use std::time::Duration;

use crate::settings::AppSettings;

#[derive(Debug, Deserialize)]
pub struct CloudTranscriptionResponse {
    pub text: String,
    #[allow(dead_code)]
    pub language_detected: Option<String>,
}

/// Check whether cloud transcription credentials are configured.
pub fn is_cloud_available(settings: &AppSettings) -> bool {
    settings
        .cloud_sync_url
        .as_ref()
        .map_or(false, |u| !u.is_empty())
        && settings
            .cloud_sync_api_key
            .as_ref()
            .map_or(false, |k| !k.is_empty())
}

/// Encode f32 audio samples (16 kHz mono) into a WAV byte buffer.
fn encode_wav(samples: &[f32]) -> Result<Vec<u8>> {
    use hound::{SampleFormat, WavSpec, WavWriter};

    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer =
            WavWriter::new(&mut buffer, spec).map_err(|e| anyhow!("WAV writer init: {e}"))?;
        for &s in samples {
            let clamped = s.max(-1.0).min(1.0);
            let pcm = (clamped * i16::MAX as f32) as i16;
            writer
                .write_sample(pcm)
                .map_err(|e| anyhow!("WAV write: {e}"))?;
        }
        writer
            .finalize()
            .map_err(|e| anyhow!("WAV finalize: {e}"))?;
    }
    Ok(buffer.into_inner())
}

/// Send audio to the Lezat backend for cloud transcription.
///
/// Retries once on transient (5xx / network) errors with a short backoff.
/// Returns immediately on 401 (bad key) or 4xx (client error).
pub fn transcribe_cloud(
    settings: &AppSettings,
    audio: &[f32],
    language: &str,
) -> Result<CloudTranscriptionResponse> {
    let base = settings
        .cloud_sync_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .map(|u| u.trim_end_matches('/').to_string())
        .ok_or_else(|| anyhow!("Cloud sync URL not configured"))?;
    let key = settings
        .cloud_sync_api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("Cloud sync API key not configured"))?;

    let url = format!("{base}/api/desktop/transcribe");
    let wav_bytes = encode_wav(audio)?;

    debug!(
        "Cloud transcription: sending {} bytes WAV ({} samples, lang={}) to {}",
        wav_bytes.len(),
        audio.len(),
        language,
        url
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| anyhow!("HTTP client: {e}"))?;

    let backoff = [1u64, 3];
    let max_attempts = backoff.len();

    for attempt in 0..max_attempts {
        let form = reqwest::blocking::multipart::Form::new()
            .part(
                "file",
                reqwest::blocking::multipart::Part::bytes(wav_bytes.clone())
                    .file_name("audio.wav")
                    .mime_str("audio/wav")
                    .map_err(|e| anyhow!("MIME: {e}"))?,
            )
            .text("language", language.to_string());

        let result = client
            .post(&url)
            .header("X-API-Key", key)
            .multipart(form)
            .send();

        match result {
            Ok(resp) if resp.status().is_success() => {
                let parsed: CloudTranscriptionResponse = resp
                    .json()
                    .map_err(|e| anyhow!("Parse transcription response: {e}"))?;
                info!(
                    "Cloud transcription OK: {} chars, lang={}",
                    parsed.text.len(),
                    parsed.language_detected.as_deref().unwrap_or("?")
                );
                return Ok(parsed);
            }
            Ok(resp) if resp.status().as_u16() == 401 => {
                return Err(anyhow!("Cloud transcription: invalid API key (401)"));
            }
            Ok(resp) if resp.status().is_server_error() => {
                let status = resp.status();
                let body = resp.text().unwrap_or_default();
                warn!(
                    "Cloud transcription attempt {}/{}: server error {} — {}",
                    attempt + 1,
                    max_attempts,
                    status,
                    body
                );
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().unwrap_or_default();
                return Err(anyhow!(
                    "Cloud transcription failed (HTTP {status}): {body}"
                ));
            }
            Err(e) => {
                warn!(
                    "Cloud transcription attempt {}/{}: network error — {e}",
                    attempt + 1,
                    max_attempts,
                );
            }
        }

        if attempt < max_attempts - 1 {
            std::thread::sleep(Duration::from_secs(backoff[attempt]));
        }
    }

    Err(anyhow!(
        "Cloud transcription failed after {max_attempts} attempts"
    ))
}
