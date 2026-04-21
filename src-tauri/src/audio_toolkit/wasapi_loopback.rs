//! Windows system-audio capture via WASAPI loopback.
//!
//! Opens the default render (output) device in loopback mode so we get a read
//! stream of whatever the speakers are playing — no virtual drivers, no user
//! install, built into Windows since Vista.
//!
//! Exposes the same open/start/stop/close shape as [`AudioRecorder`] so the
//! meeting recording loop can treat both identically.
//!
//! Compiled only on Windows; the rest of the codebase references this module
//! behind `#[cfg(target_os = "windows")]` gates.

#![cfg(target_os = "windows")]

use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{anyhow, Result};
use log::{debug, error, info, warn};
use wasapi::{
    get_default_device, initialize_mta, Direction, SampleType, ShareMode, WaveFormat,
};

const WHISPER_SR: u32 = 16_000;

enum Cmd {
    Start,
    Stop(Sender<Vec<f32>>),
    Shutdown,
}

pub struct WasapiLoopbackRecorder {
    cmd_tx: Option<Sender<Cmd>>,
    handle: Option<JoinHandle<()>>,
}

impl WasapiLoopbackRecorder {
    pub fn new() -> Result<Self> {
        Ok(Self {
            cmd_tx: None,
            handle: None,
        })
    }

    /// Start the persistent capture thread. `_device` is ignored — we always
    /// capture from the default render endpoint (whatever Windows considers
    /// the primary output at the moment).
    pub fn open(&mut self, _device: Option<cpal::Device>) -> Result<()> {
        if self.handle.is_some() {
            return Ok(());
        }
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<()>>(1);

        let handle = thread::Builder::new()
            .name("wasapi-loopback".into())
            .spawn(move || {
                run_worker(cmd_rx, ready_tx);
            })?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.cmd_tx = Some(cmd_tx);
                self.handle = Some(handle);
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(e) => Err(anyhow!("WASAPI worker never signalled readiness: {e}")),
        }
    }

    pub fn start(&self) -> Result<()> {
        self.send(Cmd::Start)
    }

    pub fn stop(&self) -> Result<Vec<f32>> {
        let (tx, rx) = mpsc::channel();
        self.send(Cmd::Stop(tx))?;
        rx.recv().map_err(|e| anyhow!("WASAPI stop response: {e}"))
    }

    pub fn close(&mut self) -> Result<()> {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Cmd::Shutdown);
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        Ok(())
    }

    fn send(&self, cmd: Cmd) -> Result<()> {
        self.cmd_tx
            .as_ref()
            .ok_or_else(|| anyhow!("WASAPI recorder not opened"))?
            .send(cmd)
            .map_err(|e| anyhow!("WASAPI channel closed: {e}"))
    }
}

impl Drop for WasapiLoopbackRecorder {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// Worker thread body. Owns all WASAPI state (audio client + capture client).
/// Sends a single readiness result through `ready_tx` once the stream is
/// started (or an error if any step fails).
fn run_worker(cmd_rx: Receiver<Cmd>, ready_tx: mpsc::SyncSender<Result<()>>) {
    let setup = match init_stream() {
        Ok(s) => {
            let _ = ready_tx.send(Ok(()));
            s
        }
        Err(e) => {
            let _ = ready_tx.send(Err(anyhow!("WASAPI init failed: {e}")));
            return;
        }
    };

    let StreamSetup {
        audio_client,
        capture_client,
        event_handle,
        sample_rate,
        channels,
        sample_type,
        bits_per_sample,
        block_align,
    } = setup;

    let mut buffer: Vec<f32> = Vec::new();
    let mut recording = false;

    loop {
        // Drain any pending commands before touching the device.
        loop {
            match cmd_rx.try_recv() {
                Ok(Cmd::Start) => {
                    buffer.clear();
                    recording = true;
                    debug!("WASAPI loopback: recording started");
                }
                Ok(Cmd::Stop(tx)) => {
                    recording = false;
                    let out = if sample_rate == WHISPER_SR {
                        std::mem::take(&mut buffer)
                    } else {
                        resample_to_16k(&buffer, sample_rate)
                    };
                    buffer.clear();
                    let _ = tx.send(out);
                    debug!("WASAPI loopback: recording stopped");
                }
                Ok(Cmd::Shutdown) => {
                    let _ = audio_client.stop_stream();
                    info!("WASAPI loopback worker exiting");
                    return;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    warn!("WASAPI command channel disconnected — shutting down worker");
                    let _ = audio_client.stop_stream();
                    return;
                }
            }
        }

        // Block until WASAPI signals new data (up to 200ms).
        if let Err(e) = event_handle.wait_for_event(200) {
            debug!("WASAPI wait_for_event: {e}");
            continue;
        }

        let frames = match capture_client.get_next_nbr_frames() {
            Ok(Some(n)) if n > 0 => n,
            Ok(_) => continue,
            Err(e) => {
                warn!("WASAPI get_next_nbr_frames: {e}");
                continue;
            }
        };

        let total_bytes = (frames as usize) * (block_align as usize);
        let mut raw = vec![0u8; total_bytes];
        if let Err(e) = capture_client.read_from_device(&mut raw) {
            warn!("WASAPI read_from_device: {e}");
            continue;
        }

        if !recording {
            continue;
        }

        let mono = decode_mono(&raw, channels as usize, sample_type, bits_per_sample);
        buffer.extend(mono);
    }
}

struct StreamSetup {
    audio_client: wasapi::AudioClient,
    capture_client: wasapi::AudioCaptureClient,
    event_handle: wasapi::Handle,
    sample_rate: u32,
    channels: u16,
    sample_type: SampleType,
    bits_per_sample: u16,
    block_align: u16,
}

fn init_stream() -> Result<StreamSetup> {
    initialize_mta()
        .ok()
        .ok_or_else(|| anyhow!("initialize_mta failed"))?;

    let device = get_default_device(&Direction::Render)
        .map_err(|e| anyhow!("get_default_device(Render) failed: {e:?}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("get_iaudioclient failed: {e:?}"))?;

    // Use the device's own mix format so we don't fight with format negotiation.
    let mix_format: WaveFormat = audio_client
        .get_mixformat()
        .map_err(|e| anyhow!("get_mixformat failed: {e:?}"))?;

    let (def_period, _min_period) = audio_client
        .get_periods()
        .map_err(|e| anyhow!("get_periods failed: {e:?}"))?;

    // Capture direction + loopback=true gives us a read of the render mix.
    audio_client
        .initialize_client(
            &mix_format,
            def_period,
            &Direction::Capture,
            &ShareMode::Shared,
            true,
        )
        .map_err(|e| anyhow!("initialize_client (loopback) failed: {e:?}"))?;

    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|e| anyhow!("set_get_eventhandle failed: {e:?}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| anyhow!("get_audiocaptureclient failed: {e:?}"))?;

    audio_client
        .start_stream()
        .map_err(|e| anyhow!("start_stream failed: {e:?}"))?;

    let sample_rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels();
    let bits_per_sample = mix_format.get_bitspersample();
    let block_align = mix_format.get_blockalign();
    let sample_type = mix_format
        .get_subformat()
        .map_err(|e| anyhow!("get_subformat failed: {e:?}"))?;

    info!(
        "WASAPI loopback ready: {sample_rate} Hz, {channels} ch, {bits_per_sample} bits, {:?}",
        sample_type
    );

    Ok(StreamSetup {
        audio_client,
        capture_client,
        event_handle,
        sample_rate,
        channels,
        sample_type,
        bits_per_sample,
        block_align,
    })
}

/// Convert interleaved WASAPI bytes to mono f32 samples in [-1, 1].
/// Handles 32-bit float and 16/24/32-bit integer PCM. Silently downmixes
/// stereo+ to mono by averaging channels.
fn decode_mono(
    raw: &[u8],
    channels: usize,
    sample_type: SampleType,
    bits_per_sample: u16,
) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let frame_bytes = bytes_per_sample * channels;
    if frame_bytes == 0 || raw.len() < frame_bytes {
        return Vec::new();
    }
    let frame_count = raw.len() / frame_bytes;
    let mut out = Vec::with_capacity(frame_count);

    for f in 0..frame_count {
        let base = f * frame_bytes;
        let mut acc = 0.0f32;
        for c in 0..channels {
            let off = base + c * bytes_per_sample;
            let sample = match (sample_type, bits_per_sample) {
                (SampleType::Float, 32) => f32::from_le_bytes([
                    raw[off],
                    raw[off + 1],
                    raw[off + 2],
                    raw[off + 3],
                ]),
                (SampleType::Int, 16) => {
                    let v = i16::from_le_bytes([raw[off], raw[off + 1]]);
                    v as f32 / i16::MAX as f32
                }
                (SampleType::Int, 24) => {
                    // 24-bit LE, sign-extended into i32.
                    let b0 = raw[off] as i32;
                    let b1 = raw[off + 1] as i32;
                    let b2 = raw[off + 2] as i32;
                    let mut v = b0 | (b1 << 8) | (b2 << 16);
                    if v & 0x0080_0000 != 0 {
                        v |= !0x00FF_FFFF; // sign-extend
                    }
                    v as f32 / 8_388_608.0 // 2^23
                }
                (SampleType::Int, 32) => {
                    let v = i32::from_le_bytes([
                        raw[off],
                        raw[off + 1],
                        raw[off + 2],
                        raw[off + 3],
                    ]);
                    v as f32 / i32::MAX as f32
                }
                _ => 0.0, // unsupported format — emit silence rather than panic
            };
            acc += sample;
        }
        out.push(acc / channels as f32);
    }
    out
}

/// Resample a mono f32 buffer from `src_rate` down to 16 kHz using simple
/// linear interpolation. For Whisper-grade speech the quality is fine and we
/// avoid an extra heavy FFT-based dependency in the hot path.
fn resample_to_16k(samples: &[f32], src_rate: u32) -> Vec<f32> {
    if samples.is_empty() || src_rate == 0 || src_rate == WHISPER_SR {
        return samples.to_vec();
    }
    let ratio = src_rate as f64 / WHISPER_SR as f64;
    let out_len = ((samples.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_f = i as f64 * ratio;
        let src_idx = src_f.floor() as usize;
        let frac = (src_f - src_idx as f64) as f32;
        let s0 = samples[src_idx];
        let s1 = if src_idx + 1 < samples.len() {
            samples[src_idx + 1]
        } else {
            s0
        };
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}

// Placeholder for stop_stream typo-protection — wasapi crate exposes
// stop_stream on AudioClient; if the crate changes names the compile
// error will point here.
#[allow(dead_code)]
fn _type_check(ac: &wasapi::AudioClient) {
    let _ = ac.stop_stream();
}
