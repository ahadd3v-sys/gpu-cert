#version 450

// Graphics-pipeline load test, conceptually like FurMark's "fur" render:
// heavy per-pixel overdraw with enough ALU work per fragment to load the
// ROP/texture/shading path the compute stress kernel doesn't exercise.

layout(location = 0) out vec4 outColor;

layout(push_constant) uniform Push {
    uint iterations;
    float time;
} pc;

void main() {
    vec2 uv = gl_FragCoord.xy * 0.01;
    vec3 acc = vec3(0.0);

    for (uint i = 0u; i < pc.iterations; i++) {
        float f = float(i) + pc.time;
        acc.x += sin(uv.x * f) * cos(uv.y * f);
        acc.y += cos(uv.x * f * 1.3) * sin(uv.y * f * 0.7);
        acc.z += sin((uv.x + uv.y) * f * 0.5);
    }

    outColor = vec4(fract(acc), 1.0);
}
