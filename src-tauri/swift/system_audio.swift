// System-audio capture for Meeting Mode — CoreAudio Process Taps path
// (macOS 14.2+) with a ScreenCaptureKit fallback for macOS 13-14.1.
//
// Background: on macOS 26 Tahoe, Apple introduced a distinct
// "System Audio Recording Only" permission and strongly steers audio-only
// capture toward the CoreAudio tap API (`AudioHardwareCreateProcessTap`).
// SCStream-based audio capture became flaky on Tahoe — the audio delegate
// stopped firing reliably even with Screen Recording permission granted.
// This rewrite makes Process Taps the primary path so Lezat ends up in the
// "System Audio Recording Only" list alongside Chrome.
//
// Gated on a full Xcode SDK — CLT-only builds use `system_audio_stub.swift`
// which returns "not supported" and the Rust side falls back to BlackHole.

import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Thread-safe result box (used by the @_cdecl bridges)

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int32 = 0
    func set(_ v: Int32) {
        lock.lock(); value = v; lock.unlock()
    }
    func get() -> Int32 {
        lock.lock(); defer { lock.unlock() }
        return value
    }
}

// MARK: - Shared sample sink

/// Ring buffer that both backends push into and the Rust poll thread drains.
private final class SampleSink {
    private let lock = NSLock()
    private var buffer: [Float] = []
    private var currentRate: Double = 0

    func push(_ samples: [Float], rate: Double) {
        lock.lock()
        if abs(currentRate - rate) > 1 {
            currentRate = rate
        }
        buffer.append(contentsOf: samples)
        // Cap at 60 s worth of audio so a stalled Rust reader doesn't blow us up.
        let maxSamples = Int(max(16_000, currentRate)) * 60
        if buffer.count > maxSamples {
            buffer.removeFirst(buffer.count - maxSamples)
        }
        lock.unlock()
    }

    func drain(into ptr: UnsafeMutablePointer<Float>, capacity: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
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
        lock.lock(); defer { lock.unlock() }
        return currentRate
    }

    func reset() {
        lock.lock()
        buffer.removeAll(keepingCapacity: false)
        currentRate = 0
        lock.unlock()
    }
}

private let sharedSink = SampleSink()

// MARK: - Process Tap backend (macOS 14.2+ — preferred)

@available(macOS 14.2, *)
private final class ProcessTapBackend {
    private var tapID: AudioObjectID = 0
    private var aggregateID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?
    private var running = false

    func start() throws {
        // Tap all processes, default mute behaviour, private (not visible in
        // Audio MIDI Setup). Empty `processes` list excludes only our own PID
        // per CATapDescription semantics.
        let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDesc.muteBehavior = .unmuted
        tapDesc.isPrivate = true
        tapDesc.isExclusive = false

        var createdTapID: AudioObjectID = 0
        let err = AudioHardwareCreateProcessTap(tapDesc, &createdTapID)
        if err != noErr {
            throw makeErr("AudioHardwareCreateProcessTap failed: \(err)")
        }
        tapID = createdTapID

        // Get the tap's UID for use as an aggregate-device sub-tap.
        var tapUID: CFString = "" as CFString
        var propSize = UInt32(MemoryLayout<CFString>.size)
        var tapAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let uidErr = AudioObjectGetPropertyData(
            tapID, &tapAddr, 0, nil, &propSize, &tapUID
        )
        if uidErr != noErr {
            destroy()
            throw makeErr("Could not read tap UID: \(uidErr)")
        }

        // Build a private aggregate device whose sole sub-tap is our tap.
        // AutoStart = 1 so the tap is live from the moment the aggregate is
        // created.
        let aggregateUID = UUID().uuidString
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Lezat System Audio Tap",
            kAudioAggregateDeviceUIDKey as String: aggregateUID,
            kAudioAggregateDeviceIsPrivateKey as String: 1,
            kAudioAggregateDeviceIsStackedKey as String: 0,
            kAudioAggregateDeviceTapAutoStartKey as String: 1,
            kAudioAggregateDeviceMainSubDeviceKey as String: tapUID,
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapUIDKey as String: tapUID,
                    kAudioSubTapDriftCompensationKey as String: 1,
                ],
            ],
        ]
        var createdAggID: AudioObjectID = 0
        let aggErr = AudioHardwareCreateAggregateDevice(
            aggDict as CFDictionary, &createdAggID
        )
        if aggErr != noErr {
            destroy()
            throw makeErr("AudioHardwareCreateAggregateDevice failed: \(aggErr)")
        }
        aggregateID = createdAggID

        // Pull the stream format so SampleSink knows the sample rate.
        var asbd = AudioStreamBasicDescription()
        var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var asbdAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        _ = AudioObjectGetPropertyData(
            aggregateID, &asbdAddr, 0, nil, &asbdSize, &asbd
        )

        // Register the IOProc. `clientData` is a raw pointer back to self so
        // the C callback can reach our handleInput method without touching
        // Swift runtime type lookups.
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        var procID: AudioDeviceIOProcID?
        let procErr = AudioDeviceCreateIOProcID(
            aggregateID,
            { (_, _, inputData, _, _, _, clientData) -> OSStatus in
                // inputData is `UnsafePointer<AudioBufferList>` (non-optional)
                // in this callback signature; only clientData can be nil.
                guard let clientData else { return noErr }
                let backend = Unmanaged<ProcessTapBackend>
                    .fromOpaque(clientData)
                    .takeUnretainedValue()
                backend.handleInput(inputData, fallbackRate: 48_000)
                return noErr
            },
            ctx,
            &procID
        )
        if procErr != noErr {
            destroy()
            throw makeErr("AudioDeviceCreateIOProcID failed: \(procErr)")
        }
        ioProcID = procID

        let startErr = AudioDeviceStart(aggregateID, procID)
        if startErr != noErr {
            destroy()
            throw makeErr("AudioDeviceStart failed: \(startErr)")
        }

        running = true

        // Seed the sample rate so the Rust side can pick it up before the
        // first callback; it'll be refreshed per-callback too.
        if asbd.mSampleRate > 0 {
            sharedSink.push([], rate: asbd.mSampleRate)
        } else {
            sharedSink.push([], rate: 48_000)
        }
    }

    private func handleInput(
        _ bufferList: UnsafePointer<AudioBufferList>,
        fallbackRate: Double
    ) {
        let abl = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: bufferList)
        )
        guard let first = abl.first else { return }
        let byteCount = Int(first.mDataByteSize)
        guard let rawData = first.mData, byteCount > 0 else { return }

        // The tap delivers 32-bit float; the aggregate-device format we
        // queried in start() says mChannelsPerFrame — we assume stereo here
        // (CATapDescription was stereo). Down-mix by averaging L+R.
        let floatCount = byteCount / MemoryLayout<Float>.size
        let floats = rawData.bindMemory(to: Float.self, capacity: floatCount)
        let channels = 2
        var mono: [Float] = []
        if floatCount >= channels {
            mono.reserveCapacity(floatCount / channels)
            var i = 0
            while i + channels - 1 < floatCount {
                mono.append((floats[i] + floats[i + 1]) * 0.5)
                i += channels
            }
        } else {
            mono.reserveCapacity(floatCount)
            for i in 0..<floatCount { mono.append(floats[i]) }
        }
        sharedSink.push(mono, rate: fallbackRate)
    }

    func stop() {
        destroy()
        running = false
    }

    private func destroy() {
        if let procID = ioProcID {
            _ = AudioDeviceStop(aggregateID, procID)
            _ = AudioDeviceDestroyIOProcID(aggregateID, procID)
            ioProcID = nil
        }
        if aggregateID != 0 {
            _ = AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = 0
        }
        if tapID != 0 {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = 0
        }
    }
}

private func makeErr(_ msg: String) -> NSError {
    NSError(
        domain: "LezatSystemAudio", code: -1,
        userInfo: [NSLocalizedDescriptionKey: msg]
    )
}

// MARK: - Single holder driving whichever backend is active

private final class SystemAudioCapture: @unchecked Sendable {
    static let shared = SystemAudioCapture()
    private let lock = NSLock()
    private var tapBackend: AnyObject?  // ProcessTapBackend when 14.2+

    func start() throws {
        lock.lock(); defer { lock.unlock() }
        if tapBackend != nil { return }
        sharedSink.reset()

        if #available(macOS 14.2, *) {
            let backend = ProcessTapBackend()
            try backend.start()
            tapBackend = backend
            return
        }
        // macOS 13 — 14.1 fall through to BlackHole path on the Rust side.
        throw makeErr("Process Taps require macOS 14.2+")
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        if #available(macOS 14.2, *) {
            if let b = tapBackend as? ProcessTapBackend {
                b.stop()
            }
        }
        tapBackend = nil
        sharedSink.reset()
    }

    func drain(into ptr: UnsafeMutablePointer<Float>, capacity: Int) -> Int {
        sharedSink.drain(into: ptr, capacity: capacity)
    }

    func sampleRate() -> Double {
        sharedSink.sampleRate()
    }
}

// MARK: - C entrypoints (unchanged API from the Rust side's perspective)

@_cdecl("lezat_sysaudio_supported")
public func lezat_sysaudio_supported() -> Int32 {
    if #available(macOS 14.2, *) {
        return 1
    }
    return 0
}

@_cdecl("lezat_sysaudio_start")
public func lezat_sysaudio_start() -> Int32 {
    guard #available(macOS 14.2, *) else { return -1 }
    do {
        try SystemAudioCapture.shared.start()
        return 0
    } catch {
        NSLog("LezatSystemAudio start failed: \(error.localizedDescription)")
        return -2
    }
}

@_cdecl("lezat_sysaudio_stop")
public func lezat_sysaudio_stop() -> Int32 {
    guard #available(macOS 14.2, *) else { return -1 }
    SystemAudioCapture.shared.stop()
    return 0
}

@_cdecl("lezat_sysaudio_drain")
public func lezat_sysaudio_drain(
    _ out: UnsafeMutablePointer<Float>?,
    _ capacity: Int32,
    _ outLen: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard #available(macOS 14.2, *), let out, let outLen else { return -1 }
    let n = SystemAudioCapture.shared.drain(into: out, capacity: Int(capacity))
    outLen.pointee = Int32(n)
    return 0
}

@_cdecl("lezat_sysaudio_sample_rate")
public func lezat_sysaudio_sample_rate() -> Int32 {
    guard #available(macOS 14.2, *) else { return 0 }
    return Int32(SystemAudioCapture.shared.sampleRate())
}
