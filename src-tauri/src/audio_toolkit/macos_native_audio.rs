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

use std::ffi::{c_char, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{anyhow, Result};
use log::{debug, info, warn};

const WHISPER_SR: u32 = 16_000;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const POLL_CHUNK_SAMPLES: usize = 4096;

unsafe extern "C" {
    fn lezat_sysaudio_set_log_sink(cb: extern "C" fn(*const c_char));
    fn lezat_sysaudio_supported() -> i32;
    fn lezat_sysaudio_start() -> i32;
    fn lezat_sysaudio_stop() -> i32;
    fn lezat_sysaudio_drain(out: *mut f32, capacity: i32, out_len: *mut i32) -> i32;
    fn lezat_sysaudio_sample_rate() -> i32;
}

/// Receives Swift NSLog-style step messages and routes them to handy.log.
/// NSLog under hardened runtime is invisible in release builds, so without
/// this we fly blind every time a Process Tap silently fails on Tahoe.
extern "C" fn swift_log_sink(msg: *const c_char) {
    if msg.is_null() {
        return;
    }
    let cs = unsafe { CStr::from_ptr(msg) };
    let s = cs.to_string_lossy();
    info!("swift sysaudio: {s}");
}

static LOG_SINK_REGISTERED: Once = Once::new();

fn ensure_log_sink_registered() {
    LOG_SINK_REGISTERED.call_once(|| unsafe {
        lezat_sysaudio_set_log_sink(swift_log_sink);
    });
}

pub fn native_system_audio_supported() -> bool {
    ensure_log_sink_registered();
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
        ensure_log_sink_registered();
        if !native_system_audio_supported() {
            return Err(anyhow!(
                "Native system audio unsupported (macOS <14.2 or CLT-only build)"
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

fn run_poll_loop(inner: Arc<Mutex<Inner>>, stop_flag: Arc<AtomicBool>, initial_rate: u32) {
    let mut scratch = vec![0f32; POLL_CHUNK_SAMPLES];
    let mut cached_rate = initial_rate;
    let mut first_sample_logged = false;
    let mut ticks_since_rate_check: u32 = 0;
    // Heartbeat counters so we can see whether the poll loop is working and
    // whether any samples have come through since the last second. We log
    // these every ~1 s regardless of whether samples arrived — it's the only
    // way to distinguish "stream never delivers samples" from "loop crashed
    // silently" from handy.log alone (Swift NSLog is suppressed for hardened
    // runtime apps).
    let mut polls_since_heartbeat: u32 = 0;
    let mut samples_this_second: u64 = 0;
    let mut total_samples: u64 = 0;

    while !stop_flag.load(Ordering::SeqCst) {
        polls_since_heartbeat += 1;
        ticks_since_rate_check += 1;
        if ticks_since_rate_check >= 50 {
            ticks_since_rate_check = 0;
            let r = unsafe { lezat_sysaudio_sample_rate() };
            if r > 0 && (r as u32) != cached_rate {
                info!("Native system audio: rate updated {cached_rate} -> {}", r);
                cached_rate = r as u32;
            }
        }

        if polls_since_heartbeat >= 50 {
            info!(
                "sysaudio heartbeat: polls={polls_since_heartbeat}, \
                 samples_this_sec={samples_this_second}, \
                 total={total_samples}, rate={cached_rate}, \
                 supported={}",
                unsafe { lezat_sysaudio_supported() }
            );
            polls_since_heartbeat = 0;
            samples_this_second = 0;
        }

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

        samples_this_second += n as u64;
        total_samples += n as u64;

        if !first_sample_logged {
            info!("Native system audio: first {n} samples arrived at {cached_rate} Hz");
            first_sample_logged = true;
        }

        let raw = &scratch[..n];
        let resampled = if cached_rate == WHISPER_SR {
            raw.to_vec()
        } else {
            linear_resample_to_16k(raw, cached_rate)
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
