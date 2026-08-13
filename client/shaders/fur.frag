#version 450

// Graphics-pipeline load test, conceptually like FurMark's "fur" render:
// heavy per-pixel overdraw with enough ALU work per fragment to load the
// ROP/texture/shading path the compute stress kernel doesn't exercise.

layout(location = 0) out vec4 outColor;

layout(push_constant) uniform Push {
    uint iterations;
    float time;
} pc;

const float TAU = 6.283185307179586;

// GPU hardware sin/cos and CPU libm sin/cos are only guaranteed to agree
// closely for well-conditioned (small) arguments — argument-reduction
// precision for huge inputs is implementation-defined per the GLSL/IEEE-754
// spec, not something a "wrong answer under load" check can rely on. With
// 4000 iterations this loop's raw arguments reach into the tens of
// thousands of radians, which showed up as real GPU/CPU divergence (not a
// hardware defect) on the first real run. Wrapping into [0, TAU) before
// every trig call keeps the same iteration count / ALU workload but makes
// both sides' sin/cos agree tightly, the way the correctness check needs.
float wrapAngle(float x) {
    return mod(x, TAU);
}

void main() {
    vec2 uv = gl_FragCoord.xy * 0.01;
    vec3 acc = vec3(0.0);

    for (uint i = 0u; i < pc.iterations; i++) {
        float f = float(i) + pc.time;
        acc.x += sin(wrapAngle(uv.x * f)) * cos(wrapAngle(uv.y * f));
        acc.y += cos(wrapAngle(uv.x * f * 1.3)) * sin(wrapAngle(uv.y * f * 0.7));
        acc.z += sin(wrapAngle((uv.x + uv.y) * f * 0.5));
    }

    outColor = vec4(fract(acc), 1.0);
}
