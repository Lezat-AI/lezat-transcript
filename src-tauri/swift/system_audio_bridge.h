// System-audio capture bridge for macOS — Rust calls these C symbols from
// `audio_toolkit::macos_native_audio`. The real implementation lives in
// `system_audio.swift` (ScreenCaptureKit, macOS 13+) and a stub in
// `system_audio_stub.swift` for environments without a full Xcode SDK.

#ifndef LEZAT_SYSTEM_AUDIO_BRIDGE_H
#define LEZAT_SYSTEM_AUDIO_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// 1 = ScreenCaptureKit is available (macOS 13+), 0 = stub / unsupported.
int32_t lezat_sysaudio_supported(void);

// Begin capture of the system audio output. Non-blocking. Returns 0 on
// success; negative on permission denied / API failure.
int32_t lezat_sysaudio_start(void);

// Stop capture. Returns 0 on success; non-zero if no stream was running.
int32_t lezat_sysaudio_stop(void);

// Drain up to `capacity` mono f32 samples (normalised to [-1, 1]) into
// `out`. Writes the number of samples produced to `out_len`. Returns 0 on
// success. If no samples are available yet returns 0 with `*out_len = 0`.
int32_t lezat_sysaudio_drain(float *out, int32_t capacity, int32_t *out_len);

// Native sample rate of the capture stream (after downmix to mono, before
// resampling). 0 if the stream hasn't started yet.
int32_t lezat_sysaudio_sample_rate(void);

#ifdef __cplusplus
}
#endif

#endif  // LEZAT_SYSTEM_AUDIO_BRIDGE_H
