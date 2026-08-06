#version 450

// Fullscreen triangle, no vertex buffer needed — standard trick to drive a
// fragment-shader-bound graphics load test.
vec2 positions[3] = vec2[](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
);

void main() {
    gl_Position = vec4(positions[gl_VertexIndex], 0.0, 1.0);
}
