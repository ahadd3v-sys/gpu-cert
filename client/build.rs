use naga::back::spv;
use naga::front::glsl;
use naga::valid::{Capabilities, ValidationFlags, Validator};
use std::env;
use std::fs;
use std::path::Path;

/// Compiles the stress/VRAM-test shaders (GLSL and WGSL, see the per-file
/// note below) to SPIR-V at build time so the binary can embed them with
/// `include_bytes!` instead of shipping loose shader files alongside the
/// exe. Uses `naga` (pure Rust) rather than `shaderc`, which needs a
/// CMake-built glslang and isn't a toolchain dependency this project wants
/// to impose.
fn main() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");

    // vram_pattern is WGSL, not GLSL: it needs atomicAdd for the shared
    // error counter, and naga's GLSL front-end has no atomic support at
    // all (its WGSL front-end does). Everything else has no atomics and
    // stays GLSL, which reads closer to the raw-Vulkan/ash style of the
    // rest of this client.
    let shaders: &[(&str, naga::ShaderStage, &str)] = &[
        ("shaders/stress.comp", naga::ShaderStage::Compute, "stress.comp.spv"),
        ("shaders/vram_pattern.wgsl", naga::ShaderStage::Compute, "vram_pattern.comp.spv"),
        ("shaders/fur.vert", naga::ShaderStage::Vertex, "fur.vert.spv"),
        ("shaders/fur.frag", naga::ShaderStage::Fragment, "fur.frag.spv"),
    ];

    for (src_path, stage, out_name) in shaders {
        println!("cargo:rerun-if-changed={src_path}");
        let source = fs::read_to_string(src_path)
            .unwrap_or_else(|e| panic!("failed to read shader {src_path}: {e}"));

        let module = if src_path.ends_with(".wgsl") {
            naga::front::wgsl::parse_str(&source)
                .unwrap_or_else(|e| panic!("failed to parse shader {src_path}: {e:?}"))
        } else {
            let options = glsl::Options::from(*stage);
            let mut frontend = glsl::Frontend::default();
            frontend
                .parse(&options, &source)
                .unwrap_or_else(|e| panic!("failed to parse shader {src_path}: {e:?}"))
        };

        let module_info = Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&module)
            .unwrap_or_else(|e| panic!("failed to validate shader {src_path}: {e:?}"));

        let spv_words = spv::write_vec(&module, &module_info, &spv::Options::default(), None)
            .unwrap_or_else(|e| panic!("failed to compile shader {src_path} to SPIR-V: {e:?}"));
        let spv_bytes: Vec<u8> = spv_words.iter().flat_map(|w| w.to_le_bytes()).collect();

        let out_path = Path::new(&out_dir).join(out_name);
        fs::write(&out_path, &spv_bytes)
            .unwrap_or_else(|e| panic!("failed to write {out_path:?}: {e}"));
    }
}
