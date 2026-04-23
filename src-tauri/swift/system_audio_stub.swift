// Stub implementation of the system-audio capture bridge for environments
// without a full Xcode SDK (our local Command-Line-Tools-only dev boxes).
// Every entrypoint reports "not supported" so the Rust side quietly falls
// back to the BlackHole-based path.

import Foundation

@_cdecl("lezat_sysaudio_set_log_sink")
public func lezat_sysaudio_set_log_sink(
    _ cb: @convention(c) (UnsafePointer<CChar>) -> Void
) {
    // No-op in the stub.
}

@_cdecl("lezat_sysaudio_supported")
public func lezat_sysaudio_supported() -> Int32 {
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
