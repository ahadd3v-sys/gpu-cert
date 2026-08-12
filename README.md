# GPU Cert

"Carfax for used GPUs" — a hardware verification certificate for GPUs sold P2P
(r/hardwareswap, Facebook Marketplace, OLX). Full scope: see the board doc and
`hardware-verification-certificate-scope.md`.

## Preview

The report page (`backend/src/report-page.ts`) is styled as an actual
certificate rather than a plain results screen — masthead, GPU spec table,
verification protocol section, ink-stamp seal. Rendered PASS/FAIL previews
(mock data, no live backend deployed yet): **https://claude.ai/code/artifact/89d5994a-7cae-46b6-b173-3e0f53daabcf**
(private artifact tied to Ahad's claude.ai account — share it from the page's
share menu if someone else needs the link).

## Product scope

Scoped deliberately to the certificate use case, not a general diagnostic
suite (there's no shortage of those — FurMark, OCCT, GpuMemTest — and we're
not trying to out-feature them). The thing nobody else in the P2P resale
space offers is a report a stranger can independently verify: signed
server-side, bound to a specific card's fingerprint, hosted at a public URL.
Buyback services (GPUsed, Cash4GPU) offer certified testing too, but only if
you sell *to them*; this stays self-serve for a seller's own listing.

## Flow

No account required, following Geekbench's model: download `gpu-cert.exe`
from the site, run it, and it submits its report and opens your browser to
the finished certificate. That certificate is public at its own URL whether
or not anyone ever signs up.

An account is purely additive, and there are two ways into one — again
mirroring Geekbench, where you can either connect the app to your account or
attach an already-uploaded result afterwards:

- **Connect the app.** The dashboard shows an upload key
  (`GPUC-XXXX-XXXX-XXXX-XXXX`). The exe asks for it once, before the tests
  start, and caches it in `%APPDATA%\gpu-cert\upload-key`. Every run after
  that arrives with `Authorization: Bearer <key>` and is attributed at ingest.
  `--forget-account` removes it; "Replace key" on the dashboard revokes it
  server-side.
- **Claim it after the fact.** A report submitted without a key is stored
  unowned and can be attached to an account from its own page later. First
  claim wins.

A mistyped key is deliberately not an error: the run represents ~16 minutes
of real GPU load, so the report is stored anonymously and the response tells
the exe it wasn't attributed, rather than discarding valid test data.

The exe is a plain console app, no GUI. The trust problem a GUI would
otherwise need to solve (a random exe reading your hardware and phoning home
looks like malware) is handled by provenance instead: it's downloaded from
the site and from a GitHub release, and the certificate it produces is
independently verifiable. Note this is weaker than the previous
login-gated framing, which could argue the download itself was a trust
signal; dropping the login gate was the deliberate trade for not making
signup a prerequisite to testing a card.

## Layout

- `client/` — Rust Windows console app. Reads NVML/ADL telemetry, computes a
  hardware fingerprint, runs three tests (compute stress, VRAM pattern,
  render integrity — see below), checks PCIe link width, and submits a
  signed report request to the backend.
- `backend/` — Hono app on Vercel (Turso for storage). Accounts
  (signup/login, JWT session cookie), ingests reports from the exe (bearer
  upload key optional, no browser session), lets a logged-in viewer claim an
  unowned report, serves the public `/r/:reportId` certificate and shareable
  badge image, and a `/dashboard` that is both the register of a user's
  certificates and where their upload key lives.
- `backend/src/theme.ts` — the shared visual language: palette tokens, the
  embedded Fraunces face, the letterhead masthead, and the page shell. Both
  `report-page.ts` and `pages.ts` import from here, so the palette is defined
  once.

## Verification protocol

Three tests, each documented and scored — see `backend/lib/certify.ts`
(`computeVerdict`) for exactly what fails a card and why:

- **Stress test** (`client/src/vulkan/stress.rs`) — sustained compute load
  via a hand-written Vulkan kernel. Telemetry (temp, clocks) is scored by
  `backend/lib/stress-analysis.ts` for over-temperature, failure to
  thermally stabilize, and excessive/unstable clock throttling.
- **VRAM pattern test** (`client/src/vulkan/vram_test.rs`) — bit-pattern
  write/verify sweep across active VRAM (memtest_vulkan-derived). Any error
  is a fail, full stop — this is the core "mining damage" detector.
- **Render integrity test** (`client/src/vulkan/fur_test.rs`) — renders a
  deterministic fullscreen fragment shader and checks a sampled pixel grid
  against the CPU-recomputed expected output every frame. Catches
  compute/rasterizer defects the other two tests can't see (neither of them
  reads back or checks its own output). **Never run against real hardware
  yet** — this dev environment can compile the Vulkan graphics-pipeline code
  but not execute it.
- **PCIe link width** (via NVML) — current vs. max-supported lane width; a
  degraded link (bad slot/connector/riser) fails with a specific reason.

All three sustained-load tests share a safety watchdog (`client/src/safety.rs`):
any test aborts immediately if the GPU crosses 100°C rather than trusting a
fixed duration to always be safe. An aborted-for-safety run is itself a
certifiable finding (shown under "Why This Failed"), not a discarded one.

## Stack decisions

See the board doc "GPU Cert: stack + architecture decision" for full
rationale. Summary: Rust + `ash` (raw Vulkan) + `libloading` (dynamic NVML)
+ ADL (not ADLX) for AMD + hand-written SPIR-V shaders compiled at build
time via `naga` (pure Rust, not `shaderc` — avoids a CMake-built
glslang/shaderc toolchain dependency). Most shaders are GLSL; the VRAM test
shader is WGSL specifically because naga's GLSL front-end has no atomic op
support, needed there for the shared error counter.

Backend is Hono, not anurfi-board's Next.js, deliberately: light on routes,
no client-side interactivity beyond plain HTML forms, doesn't need React SSR
or app-router machinery. Still deploys to Vercel and still uses
`@libsql/client` (Turso) and `@vercel/og` for the badge, both usable
standalone outside Next. Auth mirrors anurfi-board's own `lib/auth.ts`
pattern (`jose` JWT in an httpOnly cookie) rather than inventing a new
session mechanism; password hashing is Node's built-in `scrypt`, no new
dependency.

The site pages (home, login, signup, dashboard) are now designed, and they
extend the certificate's identity rather than introducing a second look: same
paper/ink/navy tokens, same Fraunces-over-Georgia pairing, same corner ticks
and letterhead masthead, all shared from `theme.ts`. Like the certificate they
commit to one fixed light treatment instead of following the viewer's
light/dark preference. Two structural choices worth keeping:

- The dashboard is a **register** — a ledger table keyed by certificate
  number, not a card grid — because a certificate number is how you refer to
  one of these documents.
- The home page's "how it works" list is numbered and the three tests are
  not. The steps are genuinely sequential; the tests run as a set with no
  meaningful order.

## Known constraints

This was scaffolded from a Linux dev environment, which shapes what could
actually be verified here vs. what's still gated on real hardware:

- **Windows cross-compilation is verified via the GNU target.**
  `x86_64-pc-windows-msvc` still fails from this box (`ring`, pulled in
  transitively via `reqwest`'s `rustls-tls` feature, needs `lib.exe` from a
  real MSVC toolchain that isn't installable here). But
  `cargo build --release --target x86_64-pc-windows-gnu` (with
  `gcc-mingw-w64-x86-64` installed) builds and links cleanly — a real
  PE32+ Windows console exe, 3.8 MB release / stripped. This is the target
  to ship from. Still unverified: whether it actually *runs* correctly —
  no real Windows machine or GPU here to test against.
- **The client's unit tests can't be executed here.** There's no native `cc`
  on this box (only `x86_64-w64-mingw32-gcc`), so `cargo test` fails to link
  its test binary even though `cargo check` and the Windows cross-build both
  pass. `account::normalize`'s tests are therefore written but unrun — worth
  running first on the Windows machine.
- **NVML/ADL/Vulkan can't be exercised at all here** — no real driver, GPU,
  or Windows Vulkan ICD in this dev environment. `cargo check`/`cargo build`
  (native Linux target) and the shader→SPIR-V build step both pass, and the
  no-GPU error path was confirmed to fail cleanly, but none of the actual
  hardware-facing code paths have run against real hardware. This applies
  in full to `fur_test.rs`'s graphics pipeline (render pass, framebuffer,
  readback) — it's the newest and most complex Vulkan code in the client,
  and the least proven.
- The 100°C safety-watchdog threshold (`safety.rs`) and the stress-telemetry
  scoring thresholds (`stress-analysis.ts`) are both conservative estimates,
  not calibrated against real GPU behavior — there's been no real hardware
  run yet to validate them against.
- **The exe download itself isn't hosted anywhere yet.** `pages.ts` points
  "Test your GPU" at a GitHub Releases URL
  (`ahadd3v-sys/gpu-cert/releases/latest/download/gpu-cert.exe`) that
  doesn't exist — no release has been cut, partly because Windows
  cross-compilation is itself still unverified (above). Ships unsigned for
  now (no code-signing budget yet); revisit once there's a release worth
  signing.
- Real Turso DB, Vercel project, and Ed25519 signing key are still
  unprovisioned — everything so far has been tested against `file:local.db`
  and throwaway keys.

Final testing is gated on a real Windows machine with an Nvidia or AMD card.
