// System-audio capture using ScreenCaptureKit (macOS 13+).
// Gated on a full Xcode SDK — CLT-only builds use `system_audio_stub.swift`
// which returns "not supported" for every entrypoint.
//
// The Rust side (audio_toolkit::macos_native_audio) polls `lezat_sysaudio_drain`
// every ~20 ms to pull accumulated samples. Internally we keep one ring of
// mono f32 samples, protected by a lock, filled from SCStream's audio output
// delegate on whatever queue ScreenCaptureKit hands us.

import AVFoundation
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

@available(macOS 13.0, *)
private final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    // Shared state between the SCStream delivery queue and the Rust poll thread.
    private let lock = NSLock()
    private var buffer: [Float] = []
    private var captureSampleRate: Double = 0

    private var stream: SCStream?
    private var isRunning = false

    static let shared = SystemAudioCapture()

    // NSLock is not async-safe — we never hold it across an `await`. Instead
    // we grab it for the brief windows where we mutate shared state, and do
    // the long-running ScreenCaptureKit calls unlocked.
    private func withLockSync<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func start() async throws {
        if withLockSync({ isRunning }) {
            return
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else {
            throw NSError(
                domain: "LezatSystemAudio",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "No display available for capture"]
            )
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true  // don't loop our own output
        config.sampleRate = 48_000
        config.channelCount = 2
        // Video is required by SCStream even when we don't want it — pin to
        // the smallest frame at the slowest rate so GPU cost is nil.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 5

        let newStream = SCStream(filter: filter, configuration: config, delegate: self)
        try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: nil)
        try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: nil)
        try await newStream.startCapture()

        withLockSync {
            self.stream = newStream
            self.isRunning = true
            self.captureSampleRate = Double(config.sampleRate)
        }
    }

    func stop() async {
        let streamToStop: SCStream? = withLockSync {
            let s = self.stream
            self.stream = nil
            self.isRunning = false
            self.buffer.removeAll(keepingCapacity: false)
            return s
        }

        if let s = streamToStop {
            try? await s.stopCapture()
        }
    }

    // Pull up to `capacity` samples; return count written.
    func drain(into ptr: UnsafeMutablePointer<Float>, capacity: Int) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let n = min(capacity, buffer.count)
        if n > 0 {
            buffer.withUnsafeBufferPointer { src in
                ptr.update(from: src.baseAddress!, count: n)
            }
            buffer.removeFirst(n)
        }
        return n
    }

    func sampleRate() -> Double {
        lock.lock()
        defer { lock.unlock() }
        return captureSampleRate
    }

    // MARK: - SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio else { return }
        guard sampleBuffer.isValid else { return }
        guard
            let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee
        else {
            return
        }

        let channels = Int(asbd.mChannelsPerFrame)
        if channels == 0 { return }

        // Grab the interleaved float buffer out of the CMSampleBuffer.
        var blockBuffer: CMBlockBuffer?
        var abl = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let buffers = UnsafeMutableAudioBufferListPointer(&abl)
        guard let first = buffers.first else { return }
        let byteCount = Int(first.mDataByteSize)
        guard let rawData = first.mData else { return }
        let floatCount = byteCount / MemoryLayout<Float>.size
        if floatCount == 0 { return }

        let floats = rawData.bindMemory(to: Float.self, capacity: floatCount)
        var mono: [Float] = []
        mono.reserveCapacity(floatCount / max(channels, 1))

        var i = 0
        while i + channels - 1 < floatCount {
            var sum: Float = 0
            for c in 0..<channels {
                sum += floats[i + c]
            }
            mono.append(sum / Float(channels))
            i += channels
        }

        lock.lock()
        buffer.append(contentsOf: mono)
        // Cap at 60 seconds of audio (48k * 60 = 2.88M samples) so we don't
        // grow unbounded if the Rust side stops draining for any reason.
        let maxSamples = 60 * Int(captureSampleRate)
        if buffer.count > maxSamples {
            buffer.removeFirst(buffer.count - maxSamples)
        }
        lock.unlock()
    }

    // MARK: - SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        NSLog("LezatSystemAudio: stream stopped with error: \(error.localizedDescription)")
        lock.lock()
        self.isRunning = false
        self.stream = nil
        lock.unlock()
    }
}

// MARK: - C entrypoints

@_cdecl("lezat_sysaudio_supported")
public func lezat_sysaudio_supported() -> Int32 {
    if #available(macOS 13.0, *) {
        return 1
    } else {
        return 0
    }
}

@_cdecl("lezat_sysaudio_start")
public func lezat_sysaudio_start() -> Int32 {
    guard #available(macOS 13.0, *) else { return -1 }

    // Bridge the async start() into a synchronous return by blocking a
    // dedicated dispatch semaphore. The caller (Rust) is already on its
    // own thread, so blocking here doesn't stall the UI.
    let semaphore = DispatchSemaphore(value: 0)
    var result: Int32 = 0

    Task.detached {
        do {
            try await SystemAudioCapture.shared.start()
        } catch {
            NSLog("LezatSystemAudio start failed: \(error.localizedDescription)")
            result = -2
        }
        semaphore.signal()
    }

    semaphore.wait()
    return result
}

@_cdecl("lezat_sysaudio_stop")
public func lezat_sysaudio_stop() -> Int32 {
    guard #available(macOS 13.0, *) else { return -1 }
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached {
        await SystemAudioCapture.shared.stop()
        semaphore.signal()
    }
    semaphore.wait()
    return 0
}

@_cdecl("lezat_sysaudio_drain")
public func lezat_sysaudio_drain(
    _ out: UnsafeMutablePointer<Float>?,
    _ capacity: Int32,
    _ outLen: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard #available(macOS 13.0, *), let out, let outLen else { return -1 }
    let n = SystemAudioCapture.shared.drain(into: out, capacity: Int(capacity))
    outLen.pointee = Int32(n)
    return 0
}

@_cdecl("lezat_sysaudio_sample_rate")
public func lezat_sysaudio_sample_rate() -> Int32 {
    guard #available(macOS 13.0, *) else { return 0 }
    return Int32(SystemAudioCapture.shared.sampleRate())
}
