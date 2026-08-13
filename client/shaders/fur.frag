#version 450

// Render-integrity load: a long dependent chain of integer ALU work per
// pixel, pushed through the real graphics pipeline (rasterizer, fragment
// shader, ROP, framebuffer) so a defect anywhere along it shows up as a
// wrong value.
//
// Integer, not floating point, and that is the whole point of this shader.
//
// The previous version accumulated 4000 float sin/cos terms and emitted
// fract(acc), with the CPU recomputing the same formula to compare against.
// That cannot work, for two independent reasons:
//
//   1. GPU and CPU float results legitimately differ. Compilers may contract
//      `a*b + c` into a single FMA (one rounding instead of two), and Vulkan
//      allows several ULP of error on transcendentals where CPU libm is
//      under one. Over 4000 iterations that compounds.
//   2. fract() of a large accumulator is a discontinuity. Whenever acc lands
//      near an integer, an arbitrarily small difference flips the output
//      between ~0.999 and ~0.000. No tolerance below 1.0 absorbs that, and a
//      tolerance of 1.0 accepts everything.
//
// On real hardware that produced a ~2.7% false mismatch rate on a healthy
// card. Integer ops have none of this freedom: xor, shift, multiply and add
// on uint are exact and wrap mod 2^32 on every conformant implementation, so
// the CPU reference and the GPU must agree bit for bit. The comparison is
// therefore exact, with no epsilon to tune, and it means the same thing on
// every GPU rather than being calibrated to one.

layout(location = 0) out uint outValue;

layout(push_constant) uniform Push {
    uint iterations;
    uint seed;
} pc;

void main() {
    // gl_FragCoord is the pixel center (integer + 0.5), so truncating gives
    // the exact integer pixel coordinate.
    uvec2 p = uvec2(gl_FragCoord.xy);

    // Distinct starting value per pixel, so the 65536 pixels of a frame
    // exercise 65536 different operand sequences rather than one repeated.
    uint h = pc.seed ^ (p.x * 0x9E3779B9u) ^ (p.y * 0x85EBCA6Bu);

    for (uint i = 0u; i < pc.iterations; i++) {
        // xorshift32, then an LCG step. The LCG matters beyond mixing: plain
        // xorshift has zero as an absorbing state, and adding a non-zero
        // constant guarantees the chain can never get stuck there.
        h ^= h << 13;
        h ^= h >> 17;
        h ^= h << 5;
        h = h * 0x2545F491u + 0x6C078965u;
    }

    outValue = h;
}
