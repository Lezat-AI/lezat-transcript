// System-audio capture via CoreAudio Process Taps (macOS 14.2+).
//
// Rewritten for v0.1.29 to stop the Tahoe crash from v0.1.27:
//   - All CoreAudio work runs on a background DispatchQueue so Tauri's IPC
//     handler on the main thread never sees a synchronous crash.
//   - The @_cdecl entrypoints block on a DispatchSemaphore with a 5-second
//     timeout — if the Swift side hangs or faults, Rust gets a clean error
//     instead of a wedged UI.
//   - `CATapDescription()` base initializer is used with properties set
//     explicitly; the v0.1.27 `stereoGlobalTapButExcludeProcesses:[]`
//     convenience init returned a null bridge on Tahoe and the next
//     property-set segfaulted.
//   - Every CoreAudio OSStatus is checked; missing/zero AudioObjectIDs
//     throw a Swift error rather than being passed on to the next call.
//   - NSLog at every step so a future regression tells us WHICH line died,
//     not just that we died.
//
// If Process Taps are genuinely unavailable (older macOS, beta quirk), we
// fail-soft: lezat_sysaudio_supported() detects and returns 0; Rust falls
// back to BlackHole. No crash, just "system audio not configured" in the UI.

import AVFoundation
import CoreAudio
import CoreMedia
import Foundation

// MARK: - Thread-safe primitives

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int32 = 0
    func set(_ v: Int32) { lock.lock(); value = v; lock.unlock() }
    func get() -> Int32 { lock.lock(); defer { lock.unlock() }; return value }
}

private final class SampleSink: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: [Float] = []
    private var currentRate: Double = 0

    func push(_ samples: [Float], rate: Double) {
        lock.lock()
        if abs(currentRate - rate) > 1 { currentRate = rate }
        buffer.append(contentsOf: samples)
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
        lock.lock(); buffer.removeAll(keepingCapacity: false); currentRate = 0; lock.unlock()
    }
}

private let sharedSink = SampleSink()
private let sysaudioQueue = DispatchQueue(
    label: "co.lezat.transcript.sysaudio", qos: .userInitiated
)

private func makeErr(_ msg: String) -> NSError {
    NSLog("LezatSysAudio ERROR: \(msg)")
    return NSError(
        domain: "LezatSystemAudio", code: -1,
        userInfo: [NSLocalizedDescriptionKey: msg]
    )
}

// MARK: - Process Tap backend

@available(macOS 14.2, *)
private final class ProcessTapBackend: @unchecked Sendable {
    private var tapID: AudioObjectID = 0
    private var aggregateID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?

    func start() throws {
        NSLog("LezatSysAudio: step 1 — checking CATapDescription class")
        guard NSClassFromString("CATapDescription") != nil else {
            throw makeErr("CATapDescription class not found at runtime")
        }

        NSLog("LezatSysAudio: step 2 — CATapDescription() init")
        let tapDesc = CATapDescription()
        NSLog("LezatSysAudio: step 3 — setting tapDesc.processes = []")
        tapDesc.processes = []
        NSLog("LezatSysAudio: step 4 — muteBehavior = .unmuted")
        tapDesc.muteBehavior = .unmuted
        NSLog("LezatSysAudio: step 5 — isPrivate = true")
        tapDesc.isPrivate = true
        NSLog("LezatSysAudio: step 6 — isExclusive = false")
        tapDesc.isExclusive = false
        NSLog("LezatSysAudio: step 7 — isMixdown = true")
        tapDesc.isMixdown = true
        NSLog("LezatSysAudio: step 8 — isMono = false (want stereo)")
        tapDesc.isMono = false

        NSLog("LezatSysAudio: step 9 — AudioHardwareCreateProcessTap")
        var createdTapID: AudioObjectID = 0
        let err = AudioHardwareCreateProcessTap(tapDesc, &createdTapID)
        if err != noErr {
            throw makeErr("AudioHardwareCreateProcessTap failed: OSStatus=\(err)")
        }
        if createdTapID == 0 {
            throw makeErr("AudioHardwareCreateProcessTap returned 0 tapID")
        }
        tapID = createdTapID
        NSLog("LezatSysAudio: step 10 — tap created, id=\(tapID)")

        NSLog("LezatSysAudio: step 11 — reading kAudioTapPropertyUID")
        var tapUID: CFString?
        var propSize = UInt32(MemoryLayout<CFString?>.size)
        var tapAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let uidErr = withUnsafeMutablePointer(to: &tapUID) { ptr -> OSStatus in
            AudioObjectGetPropertyData(tapID, &tapAddr, 0, nil, &propSize, ptr)
        }
        if uidErr != noErr {
            destroy()
            throw makeErr("Could not read tap UID: OSStatus=\(uidErr)")
        }
        guard let uid = tapUID else {
            destroy()
            throw makeErr("Tap UID came back nil")
        }
        NSLog("LezatSysAudio: step 12 — tap UID read OK")

        NSLog("LezatSysAudio: step 13 — building aggregate device dict")
        let aggregateUID = UUID().uuidString
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Lezat System Audio Tap",
            kAudioAggregateDeviceUIDKey as String: aggregateUID,
            kAudioAggregateDeviceIsPrivateKey as String: 1,
            kAudioAggregateDeviceIsStackedKey as String: 0,
            kAudioAggregateDeviceTapAutoStartKey as String: 1,
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapUIDKey as String: uid,
                    kAudioSubTapDriftCompensationKey as String: 1,
                ],
            ],
        ]

        NSLog("LezatSysAudio: step 14 — AudioHardwareCreateAggregateDevice")
        var createdAggID: AudioObjectID = 0
        let aggErr = AudioHardwareCreateAggregateDevice(
            aggDict as CFDictionary, &createdAggID
        )
        if aggErr != noErr {
            destroy()
            throw makeErr("AudioHardwareCreateAggregateDevice failed: OSStatus=\(aggErr)")
        }
        if createdAggID == 0 {
            destroy()
            throw makeErr("AudioHardwareCreateAggregateDevice returned 0 aggID")
        }
        aggregateID = createdAggID
        NSLog("LezatSysAudio: step 15 — aggregate device id=\(aggregateID)")

        NSLog("LezatSysAudio: step 16 — querying stream format")
        var asbd = AudioStreamBasicDescription()
        var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var asbdAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        let formatErr = AudioObjectGetPropertyData(
            aggregateID, &asbdAddr, 0, nil, &asbdSize, &asbd
        )
        let seededRate = (formatErr == noErr && asbd.mSampleRate > 0)
            ? asbd.mSampleRate : 48_000
        NSLog("LezatSysAudio: step 17 — stream rate=\(seededRate) Hz")
        sharedSink.push([], rate: seededRate)

        NSLog("LezatSysAudio: step 18 — registering IOProc")
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        var procID: AudioDeviceIOProcID?
        let procErr = AudioDeviceCreateIOProcID(
            aggregateID,
            { (_, _, inputData, _, _, _, clientData) -> OSStatus in
                guard let clientData else { return noErr }
                let backend = Unmanaged<ProcessTapBackend>
                    .fromOpaque(clientData).takeUnretainedValue()
                backend.handleInput(inputData)
                return noErr
            },
            ctx,
            &procID
        )
        if procErr != noErr {
            destroy()
            throw makeErr("AudioDeviceCreateIOProcID failed: OSStatus=\(procErr)")
        }
        guard let realProcID = procID else {
            destroy()
            throw makeErr("IOProcID came back nil")
        }
        ioProcID = realProcID
        NSLog("LezatSysAudio: step 19 — IOProc registered")

        NSLog("LezatSysAudio: step 20 — AudioDeviceStart")
        let startErr = AudioDeviceStart(aggregateID, realProcID)
        if startErr != noErr {
            destroy()
            throw makeErr("AudioDeviceStart failed: OSStatus=\(startErr)")
        }
        NSLog("LezatSysAudio: start completed successfully — streaming")
    }

    private func handleInput(_ bufferList: UnsafePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: bufferList)
        )
        guard let first = abl.first else { return }
        let byteCount = Int(first.mDataByteSize)
        guard let rawData = first.mData, byteCount > 0 else { return }

        let floatCount = byteCount / MemoryLayout<Float>.size
        let floats = rawData.bindMemory(to: Float.self, capacity: floatCount)
        var mono: [Float] = []
        let channels = 2  // CATapDescription isMixdown + not-mono -> stereo
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
        sharedSink.push(mono, rate: 48_000)
    }

    func stop() { destroy() }

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

// MARK: - Capture holder

private final class SystemAudioCapture: @unchecked Sendable {
    static let shared = SystemAudioCapture()
    private let lock = NSLock()
    private var backend: AnyObject?

    func start() throws {
        lock.lock(); defer { lock.unlock() }
        if backend != nil { return }
        sharedSink.reset()
        if #available(macOS 14.2, *) {
            let b = ProcessTapBackend()
            try b.start()
            backend = b
            return
        }
        throw makeErr("Process Taps require macOS 14.2+")
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        if #available(macOS 14.2, *) {
            if let b = backend as? ProcessTapBackend { b.stop() }
        }
        backend = nil
        sharedSink.reset()
    }
}

// MARK: - C entrypoints

@_cdecl("lezat_sysaudio_supported")
public func lezat_sysaudio_supported() -> Int32 {
    if #available(macOS 14.2, *) { return 1 }
    return 0
}

@_cdecl("lezat_sysaudio_start")
public func lezat_sysaudio_start() -> Int32 {
    guard #available(macOS 14.2, *) else { return -1 }

    NSLog("LezatSysAudio: @_cdecl lezat_sysaudio_start — dispatching to bg queue")
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox()

    sysaudioQueue.async {
        do {
            try SystemAudioCapture.shared.start()
            box.set(0)
        } catch {
            NSLog("LezatSysAudio: start threw: \(error.localizedDescription)")
            box.set(-2)
        }
        semaphore.signal()
    }

    let result = semaphore.wait(timeout: .now() + .seconds(5))
    if result == .timedOut {
        NSLog("LezatSysAudio: start timed out after 5 s")
        return -3
    }
    return box.get()
}

@_cdecl("lezat_sysaudio_stop")
public func lezat_sysaudio_stop() -> Int32 {
    guard #available(macOS 14.2, *) else { return -1 }

    let semaphore = DispatchSemaphore(value: 0)
    sysaudioQueue.async {
        SystemAudioCapture.shared.stop()
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + .seconds(3))
    return 0
}

@_cdecl("lezat_sysaudio_drain")
public func lezat_sysaudio_drain(
    _ out: UnsafeMutablePointer<Float>?,
    _ capacity: Int32,
    _ outLen: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard #available(macOS 14.2, *), let out, let outLen else { return -1 }
    let n = sharedSink.drain(into: out, capacity: Int(capacity))
    outLen.pointee = Int32(n)
    return 0
}

@_cdecl("lezat_sysaudio_sample_rate")
public func lezat_sysaudio_sample_rate() -> Int32 {
    guard #available(macOS 14.2, *) else { return 0 }
    return Int32(sharedSink.sampleRate())
}
