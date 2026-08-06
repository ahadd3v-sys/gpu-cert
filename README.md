# GPU Cert

"Carfax for used GPUs" — a hardware verification certificate for GPUs sold P2P
(r/hardwareswap, Facebook Marketplace, OLX). Full scope: see the board doc and
`hardware-verification-certificate-scope.md`.

## Layout

- `client/` — Rust Windows diagnostic app. Reads NVML/ADL telemetry, runs a
  Vulkan-based stress + VRAM pattern test, computes a hardware fingerprint,
  and submits a signed report request to the backend.
- `backend/` — Hono app on Vercel (Turso for storage). Ingests reports,
  signs them with a server-held Ed25519 key, serves the public `/r/:reportId`
  report page and shareable badge image.

## Stack decisions

See the board doc "GPU Cert: stack + architecture decision" for full
rationale. Summary: Rust + `ash` (raw Vulkan) + `libloading` (dynamic NVML)
+ ADL (not ADLX) for AMD + hand-written SPIR-V shaders compiled at build
time via `naga` (pure Rust, not `shaderc` — avoids a CMake-built
glslang/shaderc toolchain dependency). Most shaders are GLSL; the VRAM test
shader is WGSL specifically because naga's GLSL front-end has no atomic op
support, needed there for the shared error counter.

Backend is Hono, not anurfi-board's Next.js, deliberately: this app is three
routes (ingest, report page, badge image) with no auth and no client-side
interactivity, which doesn't need React SSR or app-router machinery. Still
deploys to Vercel and still uses `@libsql/client` (Turso) and `@vercel/og`
for the badge, both usable standalone outside Next — so the routing layer
is the only thing that changed, not the hosting/DB/image-gen stack.

## Known constraints

This was scaffolded from a Linux dev environment, which shapes what could
actually be verified here vs. what's still gated on real hardware:

- **Cross-compilation to Windows is unverified.** `x86_64-pc-windows-msvc`
  fails to build from this box: `ring` (pulled in transitively via
  `reqwest`'s `rustls-tls` feature) needs `lib.exe` from a real MSVC
  toolchain, which isn't installable here. `x86_64-pc-windows-gnu` via
  mingw-w64 would likely work but hasn't been tried (mingw-w64 isn't
  installed). Until one of these is verified, treat "does this even build
  for Windows" as an open question, not a given.
- **NVML/ADL/Vulkan can't be exercised at all here** — no real driver, GPU,
  or Windows Vulkan ICD in this dev environment. `cargo check` (type-checks
  the native Linux target) and the shader→SPIR-V build step both pass, but
  none of the actual hardware-facing code paths have run once.
- `Nvml::load()`'s `device_get_vbios` is wired to
  `nvmlSystemGetDriverVersion` as a placeholder (wrong signature — no
  device handle argument) — flagged in `client/src/nvml.rs`, not yet fixed.

Final testing is gated on a real Windows machine with an Nvidia or AMD card.
