// VRAM pattern fill/verify, ported conceptually from GpuZelenograd/memtest_vulkan
// (zlib license). Consumer GDDR6/GDDR6X has no real ECC exposed via
// NVML/ADLX, so mining-induced memory degradation is invisible to telemetry
// alone — this shader is the active test that actually catches it.
//
// Two entry points selected by `pc.mode`:
//   0 = fill:   write a deterministic pattern derived from the address
//   1 = verify: recompute the expected pattern and compare, incrementing
//               `error_count` on every mismatch
//
// Run fill and verify as separate dispatches (with a pipeline barrier /
// fence between them) so writes are guaranteed flushed to VRAM before
// verify reads them back — a false "pass" from GPU cache is the failure
// mode this test exists to rule out.
//
// WGSL, not GLSL: naga 24's GLSL front-end has no atomic function support
// at all (see build.rs), and the error counter needs atomicAdd across
// 256-wide workgroups. naga's WGSL front-end has full atomic<T> support and
// still lowers to the same SPIR-V compute shader.

struct PushConstants {
    mode: u32,   // 0 = fill, 1 = verify
    seed: u32,   // varies per test pass so repeated runs don't alias
    length: u32,
}

const MODE_FILL: u32 = 0u;

@group(0) @binding(0)
var<storage, read_write> values: array<u32>;

@group(0) @binding(1)
var<storage, read_write> error_count: atomic<u32>;

var<push_constant> pc: PushConstants;

fn expected_pattern(idx: u32) -> u32 {
    // Deterministic per-address pattern (address-derived, not all-same-value)
    // so stuck-at-0/stuck-at-1 and address-line faults both surface, same
    // idea as classic MATS+ memory test patterns.
    var x = idx ^ pc.seed;
    x = x ^ (x << 13u);
    x = x ^ (x >> 17u);
    x = x ^ (x << 5u);
    return x;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let idx = global_id.x;
    if (idx >= pc.length) {
        return;
    }

    if (pc.mode == MODE_FILL) {
        values[idx] = expected_pattern(idx);
    } else {
        if (values[idx] != expected_pattern(idx)) {
            atomicAdd(&error_count, 1u);
        }
    }
}
