//! macOS native system-audio capture via ScreenCaptureKit.
//!
//! The Swift side (see `swift/system_audio.swift`) owns the SCStream and a
//! lock-protected sample ring. Rust exposes the same open/start/stop/close
//! surface as the cpal-backed AudioRecorder so the meeting recording loop
//! can treat the three backends (cpal, WASAPI loopback, macOS native)
//! interchangeably.
//!
//! Transparent fall-back: if `lezat_sysaudio_supported` returns 0 (older
//! macOS or CLT-only build) we never try to use this path — the meeting
//! manager skips it and uses the BlackHole-based resolution instead.

#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{anyhow, Result};
use log::{debug, info, warn};

const WHISPER_SR: u32 = 16_000;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const POLL_CHUNK_SAMPLES: usize = 4096;

unsafe extern "C" {
    fn lezat_sysaudio_supported() -> i32;
    fn lezat_sysaudio_start() -> i32;
    fn lezat_sysaudio_stop() -> i32;
    fn lezat_sysaudio_drain(out: *mut f32, capacity: i32, out_len: *mut i32) -> i32;
    fn lezat_sysaudio_sample_rate() -> i32;
}

pub fn native_system_audio_supported() -> bool {
    unsafe { lezat_sysaudio_supported() != 0 }
}

pub struct MacosNativeAudioRecorder {
    inner: Arc<Mutex<Inner>>,
    poll_thread: Option<JoinHandle<()>>,
    poll_stop_flag: Arc<AtomicBool>,
}

struct Inner {
    /// Accumulated samples for the current chunk, already resampled to 16 kHz.
    buffer: Vec<f32>,
    /// True while we're actively accumulating (between start() and stop()).
    recording: bool,
    /// Whether the SCStream has been started at all.
    stream_running: bool,
}

impl MacosNativeAudioRecorder {
    pub fn new() -> Result<Self> {
        if !native_system_audio_supported() {
            return Err(anyhow!(
                "Native system audio unsupported (macOS <13 or CLT-only build)"
            ));
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                buffer: Vec::new(),
                recording: false,
                stream_running: false,
            })),
            poll_thread: None,
            poll_stop_flag: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Open the SCStream and begin polling the Swift-side ring buffer on a
    /// background thread. Samples are accumulated only while `recording` is
    /// true, but the stream itself runs continuously across start/stop cycles
    /// so chunk boundaries stay tight.
    pub fn open(&mut self, _device: Option<cpal::Device>) -> Result<()> {
        if self.poll_thread.is_some() {
            return Ok(());
        }

        let rc = unsafe { lezat_sysaudio_start() };
        if rc != 0 {
            return Err(anyhow!(
                "Native system-audio start failed (code {rc}) — check Screen Recording permission"
            ));
        }

        {
            let mut inner = self.inner.lock().unwrap();
            inner.stream_running = true;
            inner.buffer.clear();
            inner.recording = false;
        }

        let native_rate = {
            let r = unsafe { lezat_sysaudio_sample_rate() };
            if r > 0 {
                r as u32
            } else {
                48_000
            }
        };
        info!("macOS native system audio opened @ {native_rate} Hz");

        let stop_flag = self.poll_stop_flag.clone();
        let inner_arc = self.inner.clone();
        let handle = thread::Builder::new()
            .name("macos-sysaudio-poll".into())
            .spawn(move || run_poll_loop(inner_arc, stop_flag, native_rate))?;
        self.poll_thread = Some(handle);

        Ok(())
    }

    pub fn start(&self) -> Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow!("sysaudio inner mutex poisoned"))?;
        inner.buffer.clear();
        inner.recording = true;
        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<f32>> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow!("sysaudio inner mutex poisoned"))?;
        inner.recording = false;
        Ok(std::mem::take(&mut inner.buffer))
    }

    pub fn close(&mut self) -> Result<()> {
        self.poll_stop_flag.store(true, Ordering::SeqCst);
        if let Some(h) = self.poll_thread.take() {
            let _ = h.join();
        }
        let rc = unsafe { lezat_sysaudio_stop() };
        if rc != 0 {
            warn!("Native system-audio stop returned {rc}");
        }
        let mut inner = self.inner.lock().unwrap();
        inner.stream_running = false;
        inner.buffer.clear();
        inner.recording = false;
        Ok(())
    }
}

impl Drop for MacosNativeAudioRecorder {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn run_poll_loop(inner: Arc<Mutex<Inner>>, stop_flag: Arc<AtomicBool>, native_rate: u32) {
    let mut scratch = vec![0f32; POLL_CHUNK_SAMPLES];
    while !stop_flag.load(Ordering::SeqCst) {
        let mut out_len: i32 = 0;
        let rc = unsafe {
            lezat_sysaudio_drain(
                scratch.as_mut_ptr(),
                scratch.len() as i32,
                &mut out_len as *mut i32,
            )
        };
        if rc != 0 {
            warn!("Native system-audio drain error {rc}");
            thread::sleep(POLL_INTERVAL);
            continue;
        }
        let n = out_len as usize;
        if n == 0 {
            thread::sleep(POLL_INTERVAL);
            continue;
        }

        let raw = &scratch[..n];
        let resampled = if native_rate == WHISPER_SR {
            raw.to_vec()
        } else {
            linear_resample_to_16k(raw, native_rate)
        };

        if let Ok(mut guard) = inner.lock() {
            if guard.recording {
                guard.buffer.extend_from_slice(&resampled);
            }
        }

        if n < scratch.len() / 2 {
            // Buffer was nearly drained — sleep before next poll.
            thread::sleep(POLL_INTERVAL);
        }
        // else: keep polling — there's likely more audio waiting.
    }
    debug!("macOS native system-audio poll loop exited");
}

fn linear_resample_to_16k(samples: &[f32], src_rate: u32) -> Vec<f32> {
    if samples.is_empty() || src_rate == 0 || src_rate == WHISPER_SR {
        return samples.to_vec();
    }
    let ratio = src_rate as f64 / WHISPER_SR as f64;
    let out_len = ((samples.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_f = i as f64 * ratio;
        let idx = src_f.floor() as usize;
        let frac = (src_f - idx as f64) as f32;
        let s0 = samples[idx];
        let s1 = if idx + 1 < samples.len() {
            samples[idx + 1]
        } else {
            s0
        };
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}
