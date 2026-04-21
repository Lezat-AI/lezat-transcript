// System-audio capture (macOS) — DISABLED in this release.
//
// v0.1.27's CoreAudio Process Tap implementation crashed the app on macOS 26
// Tahoe inside `meeting_start`:
//
//   EXC_BAD_ACCESS (KERN_INVALID_ADDRESS at 0x10)
//   ... -[NSApplication run] → WebKit URL-scheme handler → ProcessTap init
//
// Something in CATapDescription's initialisation or the aggregate-device
// dictionary is producing a null Objective-C bridge object on Tahoe that
// then crashes the main thread. This file stubs the whole thing until I
// can build a defensive re-implementation that never takes the main thread
// down with it. Meeting Mode stays usable with mic-only (and with
// BlackHole for anyone on macOS 13 who wants system audio today).

import Foundation

@_cdecl("lezat_sysaudio_supported")
public func lezat_sysaudio_supported() -> Int32 {
    // Report "not supported" so the Rust side never tries to open us —
    // resolve_system_audio_device() falls through to the BlackHole probe.
    return 0
}

@_cdecl("lezat_sysaudio_start")
public func lezat_sysaudio_start() -> Int32 {
    return -1
}

@_cdecl("lezat_sysaudio_stop")
public func lezat_sysaudio_stop() -> Int32 {
    return -1
}

@_cdecl("lezat_sysaudio_drain")
public func lezat_sysaudio_drain(
    _ out: UnsafeMutablePointer<Float>?,
    _ capacity: Int32,
    _ outLen: UnsafeMutablePointer<Int32>?
) -> Int32 {
    if let outLen {
        outLen.pointee = 0
    }
    return 0
}

@_cdecl("lezat_sysaudio_sample_rate")
public func lezat_sysaudio_sample_rate() -> Int32 {
    return 0
}
