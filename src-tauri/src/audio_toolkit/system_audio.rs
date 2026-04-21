//! System-audio capture — the "other side of a call" for Meeting Mode.
//!
//! Capturing what the speakers are playing is deeply platform-specific:
//!
//! * **macOS** needs a virtual audio driver (BlackHole 2ch by default, free at
//!   existential.audio/blackhole). Once installed, it appears as a regular cpal
//!   input device; users route call audio through it via a Multi-Output Device.
//!   A native zero-install path via ScreenCaptureKit is planned for a later
//!   milestone.
//!
//! * **Windows** uses WASAPI loopback (zero install, built into the OS since
//!   Vista). Not wired yet in this iteration — users see a "not available on
//!   this platform yet" error. Blocked on adding the `wasapi` crate and a
//!   cpal-like wrapper.
//!
//! * **Linux** exposes monitor sources through PulseAudio / PipeWire. We look
//!   for any input device whose name contains "monitor" (PulseAudio naming
//!   convention) and pick the first one.
//!
//! The rest of the pipeline (resample to 16 kHz, chunk, Whisper) treats the
//! returned device exactly like a microphone — the only difference is the
//! source tag persisted with each transcribed chunk.

use cpal::Device;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::audio_toolkit::list_input_devices;

/// How we'll actually read samples once a source is "Available".
///
/// - `CpalDevice` wraps a regular cpal input device (used for the macOS
///   BlackHole path and the Linux PulseAudio monitor source).
/// - `WasapiLoopback` means "use the dedicated WASAPI loopback recorder";
///   no device handle is needed because the recorder always targets the
///   current default render endpoint.
pub enum SystemAudioSource {
    CpalDevice(Device),
    WasapiLoopback,
}

pub enum SystemAudioStatus {
    /// Capture is available and a source has been resolved.
    Available { source: SystemAudioSource, label: String },
    /// Capture is possible in principle but the required helper isn't set up.
    /// `install_hint` is a short, user-facing instruction.
    NotConfigured { install_hint: String },
    /// Capture isn't implemented on this platform yet.
    NotYetSupported { message: String },
}

/// Resolve a cpal `Device` that captures system output, or return a status
/// explaining why we can't.
pub fn resolve_system_audio_device() -> SystemAudioStatus {
    #[cfg(target_os = "macos")]
    {
        resolve_macos()
    }

    #[cfg(target_os = "linux")]
    {
        resolve_linux()
    }

    #[cfg(target_os = "windows")]
    {
        resolve_windows()
    }
}

#[cfg(target_os = "macos")]
fn resolve_macos() -> SystemAudioStatus {
    let devices = match list_input_devices() {
        Ok(v) => v,
        Err(_) => {
            return SystemAudioStatus::NotConfigured {
                install_hint: "Couldn't enumerate audio devices. Open \
System Settings → Privacy & Security → Microphone and grant Lezat Transcript \
access, then relaunch."
                    .to_string(),
            }
        }
    };

    // Prefer 2ch over 16ch variants — 2ch is the default BlackHole bundle.
    let mut candidate = devices
        .iter()
        .find(|d| d.name.to_lowercase().contains("blackhole 2ch"));
    if candidate.is_none() {
        candidate = devices
            .iter()
            .find(|d| d.name.to_lowercase().contains("blackhole"));
    }

    match candidate {
        Some(info) => SystemAudioStatus::Available {
            source: SystemAudioSource::CpalDevice(info.device.clone()),
            label: info.name.clone(),
        },
        None => SystemAudioStatus::NotConfigured {
            install_hint: "BlackHole audio driver not detected. Install it \
from https://existential.audio/blackhole (free), then in macOS Audio MIDI \
Setup create a Multi-Output Device with BlackHole 2ch + your speakers so you \
can still hear the call. Lezat will then pick up BlackHole automatically."
                .to_string(),
        },
    }
}

#[cfg(target_os = "linux")]
fn resolve_linux() -> SystemAudioStatus {
    let devices = match list_input_devices() {
        Ok(v) => v,
        Err(_) => {
            return SystemAudioStatus::NotConfigured {
                install_hint: "Couldn't enumerate audio devices. Make sure \
PulseAudio or PipeWire is running, then relaunch Lezat."
                    .to_string(),
            }
        }
    };

    // PulseAudio / PipeWire expose output sinks as ".monitor" input sources.
    let candidate = devices
        .iter()
        .find(|d| d.name.to_lowercase().contains("monitor"));

    match candidate {
        Some(info) => SystemAudioStatus::Available {
            source: SystemAudioSource::CpalDevice(info.device.clone()),
            label: info.name.clone(),
        },
        None => SystemAudioStatus::NotConfigured {
            install_hint: "No monitor source found. Enable one with: \
`pactl load-module module-loopback source=@DEFAULT_MONITOR@`, or use \
`pavucontrol` → Recording tab → route Lezat to Monitor of <your output>."
                .to_string(),
        },
    }
}

#[cfg(target_os = "windows")]
fn resolve_windows() -> SystemAudioStatus {
    // WASAPI loopback targets the default render endpoint, which Windows
    // maintains as whatever output the user has set as default. No device
    // handle needed — the recorder resolves the endpoint each open().
    SystemAudioStatus::Available {
        source: SystemAudioSource::WasapiLoopback,
        label: "Default Windows output (WASAPI loopback)".to_string(),
    }
}
