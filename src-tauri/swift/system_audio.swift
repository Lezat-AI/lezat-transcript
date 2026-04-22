// System-audio capture via CoreAudio Process Taps (macOS 14.2+).
//
// v0.1.30 rebuild — belt and braces after v0.1.27 and v0.1.29 both SIGSEGV'd
// in different Swift-runtime paths:
//   * v0.1.27: CATapDescription convenience init returned a null bridge
//     object on Tahoe → next property set segfaulted at offset 0x10.
//   * v0.1.29: top-level `private let queue = DispatchQueue(...)` never
//     actually initialized → dispatch_async faulted at offset 0x54.
// Root cause of the second: Swift static libraries need `-force_load` so
// the linker preserves the module initializer stubs. Without it, top-level
// Swift state stays uninitialized and any access crashes at a fixed
// offset. build.rs now passes -force_load.
//
// Belt: this file avoids top-level `let` state entirely anyway. Everything
// lives on a class as a `static let` (lazy-initialized via swift_once at
// first access) so even if the runtime-init fix regresses we don't crash
// until someone actually tries to use system audio.
//
// Braces: the @_cdecl entrypoints run synchronously — no DispatchQueue,
// no DispatchSemaphore. The CoreAudio setup takes < 1 s on any modern
// Mac; blocking the caller is fine and removes an entire crash surface.
//
// If something still goes wrong, NSLog("LezatSysAudio: step N — ...") at
// every step will tell us exactly where.

import AVFoundation
import CoreAudio
import CoreMedia
import Foundation

// MARK: - Error helper

private func makeErr(_ msg: String) -> NSError {
    NSLog("LezatSysAudio ERROR: \(msg)")
    return NSError(
        domain: "LezatSystemAudio", code: -1,
        userInfo: [NSLocalizedDescriptionKey: msg]
    )
}

// MARK: - Sample sink (shared buffer between Swift IO callback and Rust poll thread)

private final class SampleSink: @unchecked Sendable {
    // swift_once-backed lazy singleton — never nil when accessed.
    static let shared = SampleSink()

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

// MARK: - Process Tap backend

@available(macOS 14.2, *)
private final class ProcessTapBackend: @unchecked Sendable {
    private var tapID: AudioObjectID = 0
    private var aggregateID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?

    func start() throws {
        NSLog("LezatSysAudio: step 1 — CATapDescription class check")
        guard NSClassFromString("CATapDescription") != nil else {
            throw makeErr("CATapDescription class not found at runtime")
        }

        NSLog("LezatSysAudio: step 2 — CATapDescription() init")
        let tapDesc = CATapDescription()
        NSLog("LezatSysAudio: step 3 — tapDesc.processes = []")
        tapDesc.processes = []
        NSLog("LezatSysAudio: step 4 — muteBehavior = .unmuted")
        tapDesc.muteBehavior = .unmuted
        NSLog("LezatSysAudio: step 5 — isPrivate = true")
        tapDesc.isPrivate = true
        NSLog("LezatSysAudio: step 6 — isExclusive = false")
        tapDesc.isExclusive = false
        NSLog("LezatSysAudio: step 7 — isMixdown = true")
        tapDesc.isMixdown = true
        NSLog("LezatSysAudio: step 8 — isMono = false")
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
        NSLog("LezatSysAudio: step 10 — tap id=\(tapID)")

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
        NSLog("LezatSysAudio: step 12 — tap UID OK")

        NSLog("LezatSysAudio: step 13 — aggregate device dict")
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
        NSLog("LezatSysAudio: step 15 — aggregate id=\(aggregateID)")

        NSLog("LezatSysAudio: step 16 — query stream format")
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
        NSLog("LezatSysAudio: step 17 — rate=\(seededRate) Hz")
        SampleSink.shared.push([], rate: seededRate)

        NSLog("LezatSysAudio: step 18 — AudioDeviceCreateIOProcID")
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
        NSLog("LezatSysAudio: start completed — stream live")
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
        let channels = 2
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
        SampleSink.shared.push(mono, rate: 48_000)
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

// MARK: - Holder (lazy singleton)

private final class SystemAudioCapture: @unchecked Sendable {
    static let shared = SystemAudioCapture()

    private let lock = NSLock()
    private var backend: AnyObject?

    func start() throws {
        lock.lock(); defer { lock.unlock() }
        if backend != nil { return }
        SampleSink.shared.reset()
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
        SampleSink.shared.reset()
    }
}

// MARK: - C entrypoints — synchronous, no DispatchQueue reliance

@_cdecl("lezat_sysaudio_supported")
public func lezat_sysaudio_supported() -> Int32 {
    if #available(macOS 14.2, *) { return 1 }
    return 0
}

@_cdecl("lezat_sysaudio_start")
public func lezat_sysaudio_start() -> Int32 {
    guard #available(macOS 14.2, *) else { return -1 }
    NSLog("LezatSysAudio: @_cdecl start() entry")
    do {
        try SystemAudioCapture.shared.start()
        return 0
    } catch {
        NSLog("LezatSysAudio: start threw: \(error.localizedDescription)")
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
    let n = SampleSink.shared.drain(into: out, capacity: Int(capacity))
    outLen.pointee = Int32(n)
    return 0
}

@_cdecl("lezat_sysaudio_sample_rate")
public func lezat_sysaudio_sample_rate() -> Int32 {
    guard #available(macOS 14.2, *) else { return 0 }
    return Int32(SampleSink.shared.sampleRate())
}
