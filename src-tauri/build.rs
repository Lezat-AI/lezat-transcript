fn main() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    build_apple_intelligence_bridge();

    #[cfg(target_os = "macos")]
    build_system_audio_bridge();

    generate_tray_translations();

    tauri_build::build()
}

/// Generate tray menu translations from frontend locale files.
///
/// Source of truth: src/i18n/locales/*/translation.json
/// The English "tray" section defines the struct fields.
fn generate_tray_translations() {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    let out_dir = std::env::var("OUT_DIR").unwrap();
    let locales_dir = Path::new("../src/i18n/locales");

    println!("cargo:rerun-if-changed=../src/i18n/locales");

    // Collect all locale translations
    let mut translations: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for entry in fs::read_dir(locales_dir).unwrap().flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let lang = path.file_name().unwrap().to_str().unwrap().to_string();
        let json_path = path.join("translation.json");

        println!("cargo:rerun-if-changed={}", json_path.display());

        let content = fs::read_to_string(&json_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();

        if let Some(tray) = parsed.get("tray").cloned() {
            translations.insert(lang, tray);
        }
    }

    // English defines the schema
    let english = translations.get("en").unwrap().as_object().unwrap();
    let fields: Vec<_> = english
        .keys()
        .map(|k| (camel_to_snake(k), k.clone()))
        .collect();

    // Generate code
    let mut out = String::from(
        "// Auto-generated from src/i18n/locales/*/translation.json - do not edit\n\n",
    );

    // Struct
    out.push_str("#[derive(Debug, Clone)]\npub struct TrayStrings {\n");
    for (rust_field, _) in &fields {
        out.push_str(&format!("    pub {rust_field}: String,\n"));
    }
    out.push_str("}\n\n");

    // Static map
    out.push_str(
        "pub static TRANSLATIONS: Lazy<HashMap<&'static str, TrayStrings>> = Lazy::new(|| {\n",
    );
    out.push_str("    let mut m = HashMap::new();\n");

    for (lang, tray) in &translations {
        out.push_str(&format!("    m.insert(\"{lang}\", TrayStrings {{\n"));
        for (rust_field, json_key) in &fields {
            let val = tray.get(json_key).and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "        {rust_field}: \"{}\".to_string(),\n",
                escape_string(val)
            ));
        }
        out.push_str("    });\n");
    }

    out.push_str("    m\n});\n");

    fs::write(Path::new(&out_dir).join("tray_translations.rs"), out).unwrap();

    println!(
        "cargo:warning=Generated tray translations: {} languages, {} fields",
        translations.len(),
        fields.len()
    );
}

fn camel_to_snake(s: &str) -> String {
    s.chars()
        .enumerate()
        .fold(String::new(), |mut acc, (i, c)| {
            if c.is_uppercase() && i > 0 {
                acc.push('_');
            }
            acc.push(c.to_lowercase().next().unwrap());
            acc
        })
}

fn escape_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn build_apple_intelligence_bridge() {
    use std::env;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const REAL_SWIFT_FILE: &str = "swift/apple_intelligence.swift";
    const STUB_SWIFT_FILE: &str = "swift/apple_intelligence_stub.swift";
    const BRIDGE_HEADER: &str = "swift/apple_intelligence_bridge.h";

    println!("cargo:rerun-if-changed={REAL_SWIFT_FILE}");
    println!("cargo:rerun-if-changed={STUB_SWIFT_FILE}");
    println!("cargo:rerun-if-changed={BRIDGE_HEADER}");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let object_path = out_dir.join("apple_intelligence.o");
    let static_lib_path = out_dir.join("libapple_intelligence.a");

    let sdk_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .expect("Failed to locate macOS SDK")
            .stdout,
    )
    .expect("SDK path is not valid UTF-8")
    .trim()
    .to_string();

    // Check if the SDK supports FoundationModels (required for Apple Intelligence)
    let framework_path =
        Path::new(&sdk_path).join("System/Library/Frameworks/FoundationModels.framework");
    let sdk_has_framework = framework_path.exists();

    // The @Generable macro used by the real Swift file is a Swift macro that ships
    // with the full Xcode toolchain (FoundationModelsMacros plugin). Command Line
    // Tools alone don't include it, so swiftc fails to resolve the macro.
    // Detect Xcode presence via `xcode-select -p` pointing at an .app bundle.
    let developer_dir = String::from_utf8(
        Command::new("xcode-select")
            .args(["-p"])
            .output()
            .expect("Failed to invoke xcode-select")
            .stdout,
    )
    .unwrap_or_default()
    .trim()
    .to_string();
    let is_full_xcode = developer_dir.contains(".app/");

    // Respect an explicit opt-out for CI or constrained environments.
    let forced_stub = env::var("LEZAT_AI_STUB").ok().as_deref() == Some("1");

    let has_foundation_models = sdk_has_framework && is_full_xcode && !forced_stub;

    let source_file = if has_foundation_models {
        println!("cargo:warning=Building with Apple Intelligence support.");
        REAL_SWIFT_FILE
    } else {
        let reason = if forced_stub {
            "LEZAT_AI_STUB=1"
        } else if !sdk_has_framework {
            "SDK lacks FoundationModels.framework"
        } else {
            "full Xcode not found (Command Line Tools only — @Generable macro unavailable)"
        };
        println!("cargo:warning=Apple Intelligence disabled: {reason}. Building with stubs.");
        STUB_SWIFT_FILE
    };

    if !Path::new(source_file).exists() {
        panic!("Source file {} is missing!", source_file);
    }

    let swiftc_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .expect("Failed to locate swiftc")
            .stdout,
    )
    .expect("swiftc path is not valid UTF-8")
    .trim()
    .to_string();

    let toolchain_swift_lib = Path::new(&swiftc_path)
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("lib/swift/macosx"))
        .expect("Unable to determine Swift toolchain lib directory");
    let sdk_swift_lib = Path::new(&sdk_path).join("usr/lib/swift");

    // Use macOS 11.0 as deployment target for compatibility
    // The @available(macOS 26.0, *) checks in Swift handle runtime availability
    // Weak linking for FoundationModels is handled via cargo:rustc-link-arg below
    // -parse-as-library stops swiftc from emitting its implicit `_main`
    // entry point. Without this, force-loading the static lib pulls that
    // stub in and collides with Rust's main (bin target). See v0.1.30
    // failure.
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-target",
            "arm64-apple-macosx11.0",
            "-sdk",
            &sdk_path,
            "-O",
            "-import-objc-header",
            BRIDGE_HEADER,
            "-c",
            source_file,
            "-o",
            object_path
                .to_str()
                .expect("Failed to convert object path to string"),
        ])
        .status()
        .expect("Failed to invoke swiftc for Apple Intelligence bridge");

    if !status.success() {
        panic!("swiftc failed to compile {source_file}");
    }

    let status = Command::new("libtool")
        .args([
            "-static",
            "-o",
            static_lib_path
                .to_str()
                .expect("Failed to convert static lib path to string"),
            object_path
                .to_str()
                .expect("Failed to convert object path to string"),
        ])
        .status()
        .expect("Failed to create static library for Apple Intelligence bridge");

    if !status.success() {
        panic!("libtool failed for Apple Intelligence bridge");
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=apple_intelligence");
    println!(
        "cargo:rustc-link-search=native={}",
        toolchain_swift_lib.display()
    );
    println!("cargo:rustc-link-search=native={}", sdk_swift_lib.display());
    println!("cargo:rustc-link-lib=framework=Foundation");

    if has_foundation_models {
        // Use weak linking so the app can launch on systems without FoundationModels
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=FoundationModels");
    }

    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}

#[cfg(target_os = "macos")]
fn build_system_audio_bridge() {
    // ScreenCaptureKit-based system-audio capture. Mirrors the Apple
    // Intelligence pattern: real Swift file needs a full Xcode toolchain;
    // CLT-only builds fall back to a stub that returns "not supported"
    // so the Rust side transparently uses the BlackHole path instead.
    use std::env;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const REAL_SWIFT_FILE: &str = "swift/system_audio.swift";
    const STUB_SWIFT_FILE: &str = "swift/system_audio_stub.swift";
    const BRIDGE_HEADER: &str = "swift/system_audio_bridge.h";

    println!("cargo:rerun-if-changed={REAL_SWIFT_FILE}");
    println!("cargo:rerun-if-changed={STUB_SWIFT_FILE}");
    println!("cargo:rerun-if-changed={BRIDGE_HEADER}");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let object_path = out_dir.join("system_audio.o");
    let static_lib_path = out_dir.join("libsystem_audio.a");

    let sdk_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .expect("Failed to locate macOS SDK")
            .stdout,
    )
    .expect("SDK path is not valid UTF-8")
    .trim()
    .to_string();

    let framework_path =
        Path::new(&sdk_path).join("System/Library/Frameworks/ScreenCaptureKit.framework");
    let sdk_has_sck = framework_path.exists();

    // Same Xcode detection used by the Apple Intelligence bridge.
    let developer_dir = String::from_utf8(
        Command::new("xcode-select")
            .args(["-p"])
            .output()
            .expect("Failed to invoke xcode-select")
            .stdout,
    )
    .unwrap_or_default()
    .trim()
    .to_string();
    let is_full_xcode = developer_dir.contains(".app/");

    // Separate opt-out from LEZAT_AI_STUB — LEZAT_AI_STUB was only meant to
    // gate the Apple Intelligence bridge, and coupling the system-audio
    // stub to it silently defeated the whole ScreenCaptureKit path in CI
    // (which sets LEZAT_AI_STUB=1 to avoid the AI macros).
    let forced_stub = env::var("LEZAT_SYSAUDIO_STUB").ok().as_deref() == Some("1");

    let use_real = sdk_has_sck && is_full_xcode && !forced_stub;

    let (source_file, target_arch) = if use_real {
        println!("cargo:warning=Building with native ScreenCaptureKit system-audio.");
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        (REAL_SWIFT_FILE, arch)
    } else {
        let reason = if forced_stub {
            "LEZAT_SYSAUDIO_STUB=1"
        } else if !sdk_has_sck {
            "SDK lacks ScreenCaptureKit.framework"
        } else {
            "full Xcode not found (Command Line Tools only)"
        };
        println!(
            "cargo:warning=System-audio native path disabled: {reason}. Falling back to BlackHole."
        );
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        (STUB_SWIFT_FILE, arch)
    };

    if !Path::new(source_file).exists() {
        panic!("System-audio source file {} is missing!", source_file);
    }

    let swiftc_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .expect("Failed to locate swiftc")
            .stdout,
    )
    .expect("swiftc path is not valid UTF-8")
    .trim()
    .to_string();

    let toolchain_swift_lib = Path::new(&swiftc_path)
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("lib/swift/macosx"))
        .expect("Unable to determine Swift toolchain lib directory");
    let sdk_swift_lib = Path::new(&sdk_path).join("usr/lib/swift");

    // -parse-as-library: stop swiftc from emitting `_main`. Required
    // because we -force_load this archive below, which pulls in every
    // symbol including the implicit `_main` stub swiftc adds otherwise.
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-target",
            &format!("{target_arch}-apple-macosx11.0"),
            "-sdk",
            &sdk_path,
            "-O",
            "-import-objc-header",
            BRIDGE_HEADER,
            "-c",
            source_file,
            "-o",
            object_path
                .to_str()
                .expect("Failed to convert object path to string"),
        ])
        .status()
        .expect("Failed to invoke swiftc for system_audio bridge");

    if !status.success() {
        panic!("swiftc failed to compile {source_file}");
    }

    let status = Command::new("libtool")
        .args([
            "-static",
            "-o",
            static_lib_path
                .to_str()
                .expect("Failed to convert static lib path to string"),
            object_path
                .to_str()
                .expect("Failed to convert object path to string"),
        ])
        .status()
        .expect("Failed to create static library for system_audio bridge");

    if !status.success() {
        panic!("libtool failed for system_audio bridge");
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    // -force_load is required for Swift static libraries: without it, the
    // linker dead-strips the module initializer stubs (`_swift_FORCE_LOAD_$`
    // and friends), Swift runtime setup never runs, and top-level `let`
    // globals stay nil at runtime. That's what killed v0.1.27 and v0.1.29 —
    // calling into any top-level singleton returned a null pointer and the
    // next method dispatch SIGSEGV'd. Force-loading the archive keeps all
    // Swift module-init symbols alive.
    println!(
        "cargo:rustc-link-arg=-Wl,-force_load,{}",
        static_lib_path.display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        toolchain_swift_lib.display()
    );
    println!("cargo:rustc-link-search=native={}", sdk_swift_lib.display());
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreAudio");

    if use_real {
        // Weak-link ScreenCaptureKit so an older macOS at runtime still launches
        // (the supported() check returns 0 and we fall back to BlackHole).
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=ScreenCaptureKit");
    }

    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
