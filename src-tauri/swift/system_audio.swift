// System-audio capture via CoreAudio Process Taps (macOS 14.2+).
//
// Major rewrite — three independent research passes against AudioCap (Gui
// Rambo, Apple-blessed reference), audiotee (PR #14 fix for the exact "noErr
// everywhere, IOProc never fires" Tahoe symptom we were hitting), and
// AudioCaptureKit converged on the same set of changes:
//
//   1. Use the convenience init `CATapDescription(stereoGlobalTapButExcludeProcesses: [])`.
//      The no-arg `CATapDescription()` + `processes = []` reads as "include
//      exactly these zero processes" → tap nothing. This was our #1 bug.
//
//   2. Set `tapDesc.uuid = UUID()` explicitly. The no-arg init may leave it
//      nil/zero on Tahoe, breaking the tap↔aggregate matching that follows.
//
//   3. In the aggregate's TapList, use `tapDesc.uuid.uuidString` — NOT the
//      runtime `kAudioTapPropertyUID`. Apple's HAL matches sub-tap entries
//      against the description UUID. Mismatch = silent, no error. (audiotee
//      PR #14 is exactly this fix.)
//
//   4. Anchor the aggregate to the system's default output device via
//      `kAudioAggregateDeviceMainSubDeviceKey` + `kAudioAggregateDeviceSubDeviceListKey`.
//      Without a real sub-device, the aggregate has no clock and the IOProc
//      cycle never ticks on Tahoe.
//
//   5. Use booleans (true/false) not CFNumbers (1/0) for the aggregate
//      dictionary boolean keys. Tahoe's toll-free bridge has been observed
//      rejecting numbers for these.
//
//   6. Read stream format off the TAP via `kAudioTapPropertyFormat` (scope
//      Global), not off the aggregate's input scope. The latter often
//      returns garbage or errors silently.
//
//   7. `AudioDeviceCreateIOProcIDWithBlock` + a dedicated DispatchQueue
//      schedules more reliably against the HAL than the legacy IOProc with
//      Unmanaged ctx (which also gave us a class of crashes earlier).
//
//   8. Respect the real channel count and `mFormatFlags`
//      (kAudioFormatFlagIsNonInterleaved) in the IO callback. Hard-coding
//      stereo+interleaved produces silence or garbage on many setups.
//
//   9. Route Swift logs into Rust's handy.log via a C callback. NSLog
//      under hardened runtime goes to /dev/null in release builds, so the
//      step-by-step diagnostics we added in v0.1.30 were invisible. The
//      log-sink bridge means the next failure will be visible immediately.
//
// Confirmed NOT the issue (per all three research passes): ad-hoc signing,
// missing entitlements. AudioCap works ad-hoc-signed; TCC tracks by cdhash.

import AVFoundation
import CoreAudio
import CoreMedia
import Foundation

// MARK: - Log sink (Rust callback bridge)

private typealias LezatLogSink = @convention(c) (UnsafePointer<CChar>) -> Void
private nonisolated(unsafe) var logSink: LezatLogSink?

private func logStep(_ msg: String) {
    NSLog("LezatSysAudio: \(msg)")
    if let sink = logSink {
        msg.withCString { sink($0) }
    }
}

private func makeErr(_ msg: String) -> NSError {
    logStep("ERROR: \(msg)")
    return NSError(
        domain: "LezatSystemAudio", code: -1,
        userInfo: [NSLocalizedDescriptionKey: msg]
    )
}

// MARK: - Sample sink (shared buffer between IOProc callback and Rust poll thread)

private final class SampleSink: @unchecked Sendable {
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
    private let ioQueue = DispatchQueue(label: "co.lezat.sysaudio.io", qos: .userInitiated)

    // Real format learned from kAudioTapPropertyFormat at start time.
    private var streamRate: Double = 48_000
    private var channels: Int = 2
    private var nonInterleaved: Bool = false

    // Per-callback diagnostics.
    private var ioCallbackCount: UInt64 = 0
    private var emptyCallbackCount: UInt64 = 0
    private var firstCallbackLogged = false

    func start() throws {
        // ---- Step 1: build the tap description with the convenience init
        logStep("step 1 — CATapDescription(stereoGlobalTapButExcludeProcesses: [])")
        let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDesc.uuid = UUID()
        tapDesc.name = "Lezat System Audio Tap"
        tapDesc.muteBehavior = .unmuted
        tapDesc.isPrivate = true
        // Do NOT touch processes / isExclusive / isMixdown / isMono after
        // this — the convenience init has already wired them correctly.
        logStep("step 2 — tap uuid=\(tapDesc.uuid.uuidString)")

        // ---- Step 3: create the tap
        logStep("step 3 — AudioHardwareCreateProcessTap")
        var createdTapID: AudioObjectID = 0
        let err = AudioHardwareCreateProcessTap(tapDesc, &createdTapID)
        if err != noErr {
            throw makeErr("AudioHardwareCreateProcessTap failed: OSStatus=\(err)")
        }
        if createdTapID == 0 {
            throw makeErr("AudioHardwareCreateProcessTap returned 0 tapID")
        }
        tapID = createdTapID
        logStep("step 4 — tap created id=\(tapID)")

        // ---- Step 5: read the actual stream format off the TAP
        logStep("step 5 — query kAudioTapPropertyFormat on tap")
        var asbd = AudioStreamBasicDescription()
        var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let fmtErr = AudioObjectGetPropertyData(
            tapID, &fmtAddr, 0, nil, &asbdSize, &asbd
        )
        if fmtErr == noErr && asbd.mSampleRate > 0 {
            streamRate = asbd.mSampleRate
            channels = max(1, Int(asbd.mChannelsPerFrame))
            nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
            logStep(
                "step 6 — tap format rate=\(streamRate) ch=\(channels) " +
                "nonInterleaved=\(nonInterleaved) flags=\(asbd.mFormatFlags) " +
                "bytesPerFrame=\(asbd.mBytesPerFrame)"
            )
        } else {
            logStep("step 6 — kAudioTapPropertyFormat err=\(fmtErr) — defaulting 48kHz/stereo/interleaved")
        }
        SampleSink.shared.push([], rate: streamRate)

        // ---- Step 7: look up the default system output device UID — needed
        // as the aggregate's clock anchor (MainSubDevice + SubDeviceList).
        logStep("step 7 — query default system output device")
        var sysOutID: AudioDeviceID = 0
        var sysOutSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var sysOutAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let sysOutErr = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &sysOutAddr, 0, nil, &sysOutSize, &sysOutID
        )
        if sysOutErr != noErr || sysOutID == 0 {
            destroy()
            throw makeErr(
                "Default system output device unavailable: err=\(sysOutErr) id=\(sysOutID)"
            )
        }
        var outputUID: CFString?
        var uidSize = UInt32(MemoryLayout<CFString?>.size)
        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let uidErr = withUnsafeMutablePointer(to: &outputUID) { ptr in
            AudioObjectGetPropertyData(sysOutID, &uidAddr, 0, nil, &uidSize, ptr)
        }
        if uidErr != noErr {
            destroy()
            throw makeErr("Could not read output device UID: OSStatus=\(uidErr)")
        }
        guard let outUIDCF = outputUID else {
            destroy()
            throw makeErr("Default output UID came back nil")
        }
        let outUID = outUIDCF as String
        logStep("step 8 — default output UID=\(outUID)")

        // ---- Step 9: create the aggregate device — mirror AudioCap exactly
        logStep("step 9 — AudioHardwareCreateAggregateDevice")
        let aggregateUID = UUID().uuidString
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey         as String: "Lezat System Audio Tap",
            kAudioAggregateDeviceUIDKey          as String: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey as String: outUID,
            kAudioAggregateDeviceIsPrivateKey    as String: true,
            kAudioAggregateDeviceIsStackedKey    as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [
                [kAudioSubDeviceUIDKey as String: outUID]
            ],
            kAudioAggregateDeviceTapListKey      as String: [
                [
                    kAudioSubTapDriftCompensationKey as String: true,
                    // CRITICAL: description UUID, not kAudioTapPropertyUID.
                    kAudioSubTapUIDKey as String: tapDesc.uuid.uuidString,
                ]
            ],
        ]

        var createdAggID: AudioObjectID = 0
        let aggErr = AudioHardwareCreateAggregateDevice(
            aggDict as CFDictionary, &createdAggID
        )
        if aggErr != noErr {
            destroy()
            throw makeErr(
                "AudioHardwareCreateAggregateDevice failed: OSStatus=\(aggErr)"
            )
        }
        if createdAggID == 0 {
            destroy()
            throw makeErr("AudioHardwareCreateAggregateDevice returned 0 aggID")
        }
        aggregateID = createdAggID
        logStep("step 10 — aggregate id=\(aggregateID) uid=\(aggregateUID)")

        // ---- Step 11: register the IOProc on a dedicated dispatch queue.
        // Block + queue is more reliable on Tahoe than the legacy
        // function-pointer + Unmanaged-ctx variant.
        logStep("step 11 — AudioDeviceCreateIOProcIDWithBlock")
        var procID: AudioDeviceIOProcID?
        let procErr = AudioDeviceCreateIOProcIDWithBlock(
            &procID, aggregateID, ioQueue
        ) { [weak self] _, inputData, _, _, _ in
            self?.handleInput(inputData)
        }
        if procErr != noErr {
            destroy()
            throw makeErr(
                "AudioDeviceCreateIOProcIDWithBlock failed: OSStatus=\(procErr)"
            )
        }
        guard let realProcID = procID else {
            destroy()
            throw makeErr("IOProcID came back nil")
        }
        ioProcID = realProcID
        logStep("step 12 — IOProc registered")

        // ---- Step 13: start the device
        logStep("step 13 — AudioDeviceStart")
        let startErr = AudioDeviceStart(aggregateID, realProcID)
        if startErr != noErr {
            destroy()
            throw makeErr("AudioDeviceStart failed: OSStatus=\(startErr)")
        }

        // ---- Step 14: post-start sanity — query kAudioDevicePropertyDeviceIsRunning
        var isRunning: UInt32 = 0
        var runSize = UInt32(MemoryLayout<UInt32>.size)
        var runAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunning,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let runErr = AudioObjectGetPropertyData(
            aggregateID, &runAddr, 0, nil, &runSize, &isRunning
        )
        logStep(
            "step 14 — DeviceIsRunning err=\(runErr) value=\(isRunning) — " +
            "stream live, awaiting first IOProc callback"
        )

        // ---- Step 14b: read the aggregate's NOMINAL sample rate. The tap's
        // kAudioTapPropertyFormat reports a logical rate (e.g. 48 kHz) but
        // the IOProc actually delivers at the aggregate's clock rate, which
        // can differ wildly when the system output is a Bluetooth headset
        // (HFP/SCO often clocks the aggregate at 16 kHz, A2DP at 44.1/48).
        // Trusting the tap format produced 3× compressed audio in v0.1.35.
        var aggRate: Float64 = 0
        var aggRateSize = UInt32(MemoryLayout<Float64>.size)
        var aggRateAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let aggRateErr = AudioObjectGetPropertyData(
            aggregateID, &aggRateAddr, 0, nil, &aggRateSize, &aggRate
        )
        if aggRateErr == noErr && aggRate > 0 && abs(aggRate - streamRate) > 1 {
            logStep(
                "step 14b — aggregate nominal rate=\(aggRate) differs from " +
                "tap-reported rate=\(streamRate); using aggregate rate"
            )
            streamRate = aggRate
            SampleSink.shared.push([], rate: streamRate)
        } else {
            logStep(
                "step 14b — aggregate nominal rate=\(aggRate) err=\(aggRateErr) " +
                "(tap rate=\(streamRate))"
            )
        }

        // Schedule a callback-count probe at +2s so we know whether the IOProc
        // ever fired even if the user stops the meeting before sample drain.
        ioQueue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            logStep(
                "step 15 — 2s probe: ioCallbacks=\(self.ioCallbackCount), " +
                "emptyCallbacks=\(self.emptyCallbackCount)"
            )
        }
    }

    private func handleInput(_ bufferList: UnsafePointer<AudioBufferList>) {
        ioCallbackCount += 1

        let abl = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: bufferList)
        )
        guard let first = abl.first else {
            emptyCallbackCount += 1
            return
        }
        let byteCount = Int(first.mDataByteSize)
        guard let rawData = first.mData, byteCount > 0 else {
            emptyCallbackCount += 1
            return
        }
        let floatCount = byteCount / MemoryLayout<Float>.size
        let floats = rawData.bindMemory(to: Float.self, capacity: floatCount)

        if !firstCallbackLogged {
            firstCallbackLogged = true
            logStep(
                "first IO callback — bufferCount=\(abl.count) " +
                "byteCount=\(byteCount) floatCount=\(floatCount) " +
                "rate=\(streamRate) ch=\(channels)"
            )
        }

        // Mixdown to mono. Layout depends on flags:
        //  - interleaved: [L R L R L R ...] in buffer 0
        //  - non-interleaved: buffer 0 = L, buffer 1 = R, etc.
        var mono: [Float] = []
        if nonInterleaved && abl.count >= channels && channels > 1 {
            // Non-interleaved: average across the per-channel buffers.
            let perChannelFloats = byteCount / MemoryLayout<Float>.size
            mono.reserveCapacity(perChannelFloats)
            // Bind every channel buffer up front.
            var channelPtrs: [UnsafePointer<Float>] = []
            channelPtrs.reserveCapacity(channels)
            for c in 0..<channels {
                guard let raw = abl[c].mData else { continue }
                channelPtrs.append(
                    raw.bindMemory(to: Float.self, capacity: perChannelFloats)
                )
            }
            let activeChannels = channelPtrs.count
            if activeChannels == 0 {
                emptyCallbackCount += 1
                return
            }
            for i in 0..<perChannelFloats {
                var s: Float = 0
                for c in 0..<activeChannels { s += channelPtrs[c][i] }
                mono.append(s / Float(activeChannels))
            }
        } else if channels > 1 {
            // Interleaved stereo+ — average the channels frame by frame.
            let frames = floatCount / channels
            mono.reserveCapacity(frames)
            var i = 0
            while i + channels - 1 < floatCount {
                var s: Float = 0
                for c in 0..<channels { s += floats[i + c] }
                mono.append(s / Float(channels))
                i += channels
            }
        } else {
            // Mono passthrough.
            mono.reserveCapacity(floatCount)
            for i in 0..<floatCount { mono.append(floats[i]) }
        }
        SampleSink.shared.push(mono, rate: streamRate)
    }

    func stop() {
        logStep(
            "stop — ioCallbacks=\(ioCallbackCount) emptyCallbacks=\(emptyCallbackCount)"
        )
        destroy()
    }

    private func destroy() {
        if let procID = ioProcID, aggregateID != 0 {
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

// MARK: - C entrypoints

@_cdecl("lezat_sysaudio_set_log_sink")
public func lezat_sysaudio_set_log_sink(
    _ cb: @convention(c) (UnsafePointer<CChar>) -> Void
) {
    logSink = cb
}

@_cdecl("lezat_sysaudio_supported")
public func lezat_sysaudio_supported() -> Int32 {
    if #available(macOS 14.2, *) { return 1 }
    return 0
}

@_cdecl("lezat_sysaudio_start")
public func lezat_sysaudio_start() -> Int32 {
    guard #available(macOS 14.2, *) else { return -1 }
    logStep("@_cdecl start() entry")
    do {
        try SystemAudioCapture.shared.start()
        return 0
    } catch {
        logStep("start threw: \(error.localizedDescription)")
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
