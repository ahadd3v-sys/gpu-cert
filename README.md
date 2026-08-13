# GPU Cert

"Carfax for used GPUs" — a hardware verification certificate for GPUs sold P2P
(r/hardwareswap, Facebook Marketplace, OLX). Full scope: see the board doc and
`hardware-verification-certificate-scope.md`.

## Preview

The site's live now: **https://gpu-cert.vercel.app**.

The report page (`backend/src/report-page.ts`) is styled as an actual
certificate rather than a plain results screen — masthead, GPU spec table,
verification protocol section, ink-stamp seal. Palette and type across the
whole site (`backend/src/theme.ts`) are anurfi.net's own tokens, reused
directly rather than reinvented, so GPU Cert reads as the same issuing
body's family rather than a one-off identity. Screenshot gallery of the
redesign (mock data): **https://claude.ai/code/artifact/cbca434f-8a03-4e15-9e40-0045c12a1e8a**
(private artifact tied to Ahad's claude.ai account — share it from the page's
share menu if someone else needs the link). The older Fraunces/navy preview
link is stale.

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
  badge image, a `/verify` surface (see below), and a `/dashboard` that is
  both the register of a user's certificates and where their upload key
  lives.
- `backend/src/theme.ts` — the shared visual language: palette tokens, the
  embedded Fraunces face, the letterhead masthead, and the page shell. Both
  `report-page.ts` and `pages.ts` import from here, so the palette is defined
  once.

## Attestation

A signature only proves the server issued the document. It says nothing about
whether a test ran, and `/api/certify` used to sign any JSON it was handed, so
a perfect certificate for a dead card cost one HTTP request.

A client running on someone else's machine can never be made provably honest,
so `backend/lib/attestation.ts` aims at cost instead. A session is opened
before any load is applied and consumed by the submission, so the *server*
times the run: claiming 16 minutes of testing requires 16 minutes to pass, with
heartbeats across them. Sessions are single-use and bound to the card's
fingerprint. On top of that, values that are arithmetically bound to each other
are checked (`pixels_checked` is `frames_rendered * 65536`, mismatches cannot
exceed pixels checked), as is an absolute bandwidth ceiling no real hardware
approaches.

This raises forgery from one request to a sustained 16-minute impersonation. It
does not make it impossible, and nothing client-side can.

## Verification

The differentiator is that a buyer can check a certificate without trusting
the seller, so that has to be a real, reachable thing rather than a claim in
the footer:

- `/verify` takes a certificate number (`GPUC-1A2B3C4D`, the short form
  printed prominently on the certificate) or a full report ID, and
  `/verify/:reference` does the same as a linkable path.
- The check rebuilds the signed payload **from the stored row** and
  re-verifies the Ed25519 signature against it. It never reads a stored
  "valid" flag, so altering any covered field in the database makes the
  signature stop matching.
- `/.well-known/gpu-cert-key.pem` publishes the public key, so the signature
  can be checked with any Ed25519 tool instead of only by this server.

Ingest and verification build that payload through two different functions
from two different shapes, and they must agree byte for byte forever or every
certificate ever issued silently becomes unverifiable. `npm test` asserts
they do, plus that eight distinct kinds of tampering (flipped verdict, zeroed
VRAM errors, swapped fingerprint, moved issue date, and so on) are each
detected.

The page is also explicit about what a valid signature does *not* prove: that
the person showing it owns the card. That is what the hardware fingerprint on
the certificate is for.

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

  The tested region is split into several buffers, each sized at runtime to
  `min(maxStorageBufferRange, maxMemoryAllocationSize, heap size, 1 GiB)`.
  This is not an optimization. `maxStorageBufferRange` is a `uint32_t`, so no
  device will ever bind more than 4 GiB-1 to one descriptor, and exceeding it
  doesn't fail loudly: the range truncates and the shader silently cannot
  address past it. Allocating 85% of an 8 GiB card as one buffer therefore
  left only `7,287,183,768 mod 2^32` = 2.99 GB reachable, and every element
  beyond that read back as zero and was counted as a memory error. Every
  segment is filled before any segment is verified, so a verify can never be
  served out of cache from the fill that just happened, and each dispatch is
  chunked short enough not to trip Windows' TDR watchdog.

  How much gets tested is bounded by what is actually free, not by the card's
  size, so `VK_EXT_memory_budget` is used to ask the driver directly rather
  than discovering the ceiling by allocating until something fails (which
  understates it, since the first refusal comes well before the real limit).
  Coverage is printed as a percentage during the run and shown on the
  certificate, because "0 errors" over 49% of a card is a materially weaker
  claim than over 85% and the certificate should not blur the two.
- **Render integrity test** (`client/src/vulkan/fur_test.rs`) — renders a
  deterministic fullscreen fragment shader and compares **every pixel of
  every frame**, bit for bit, against a CPU-computed reference. Catches
  compute/rasterizer defects the other two tests can't see (neither of them
  reads back or checks its own output).

  The shader is integer-only, and that is load-bearing rather than a style
  choice. It originally accumulated 4000 float `sin`/`cos` terms and emitted
  `fract(acc)`, compared against a CPU recomputation within an epsilon. That
  cannot work: GPU compilers may contract `a*b + c` into a single FMA, Vulkan
  permits several ULP of error on transcendentals, and `fract` of a large
  accumulator is a discontinuity, so a near-integer accumulator flips the
  output by ~1.0 on a vanishingly small input difference. No epsilon below
  1.0 absorbs that and 1.0 accepts everything. On a healthy RX 6600 it
  produced a 2.7% false-mismatch rate. `xor`/shift/multiply/add on `uint`
  are exact and wrap mod 2^32 on every conformant implementation, so the
  comparison is now exact with no tolerance to tune, and it means the same
  thing on every GPU instead of being calibrated to one. The attachment is
  `VK_FORMAT_R32_UINT`, which carries mandatory `COLOR_ATTACHMENT_BIT`
  support in the spec, so this is portable rather than hardware-specific.
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
- **Resolved: the client's unit tests run.** A native `cc` is present now, so
  `cargo test` links and passes (7 tests). The backend has its own checks:
  `npm run check` (typecheck + signing round-trip and tamper detection) and
  `npm run smoke` (boots the server against a throwaway DB and exercises
  ingest, the certificate page, verification, the badge and the redirect
  guard end to end, 19 assertions).
- **NVML/ADL/Vulkan can't be exercised at all here** — no real driver, GPU,
  or Windows Vulkan ICD in this dev environment. `cargo check`/`cargo build`
  (native Linux target) and the shader→SPIR-V build step both pass, and the
  no-GPU error path was confirmed to fail cleanly, but none of the actual
  hardware-facing code paths have run against real hardware. This applies
  in full to `fur_test.rs`'s graphics pipeline (render pass, framebuffer,
  readback) — it's the newest and most complex Vulkan code in the client,
  and the least proven.
- **AMD support (`client/src/adl.rs`) is wired in but unverified against
  real hardware.** `main.rs` tries NVML first, falls back to ADL2-based
  telemetry (`ADL2_New_QueryPMLogData_Get`) for AMD. Struct layouts and
  sensor IDs are ground-truthed against AMD's public ADL SDK
  (GPUOpen-LibrariesAndSDKs/display-library) and cross-checked against
  hashcat's `ext_ADL.c`, not hand-typed from memory — but this is still the
  first real run, not a confirmed-working path. Known limitation, not a
  bug: ADL has no verified call for a card's true *max* PCIe lane count
  (only current), so `pcie_link_width_current`/`_max` are reported equal
  for AMD — the degraded-slot check doesn't work yet on AMD, deliberately,
  rather than risk a hardcoded max false-failing a card that's electrically
  narrower than x16 by design (the RX 6600 non-XT, this project's own AMD
  test card, is x8).
- The 100°C safety-watchdog threshold (`safety.rs`) and the stress-telemetry
  scoring thresholds (`stress-analysis.ts`) are both conservative estimates,
  not calibrated against real GPU behavior — there's been no real hardware
  run yet to validate them against.
- **Resolved:** the exe is hosted and downloadable. `pages.ts`'s "Test your
  GPU" points at
  `ahadd3v-sys/gpu-cert/releases/latest/download/gpu-cert.exe`, which now
  resolves — `v0.1.1` is cut and the repo is public (release assets on a
  private repo 404 for anyone unauthenticated, which is everyone visiting
  the site; making the repo public was also the deliberate call for the
  product's own trust story, not just a distribution fix). Ships unsigned
  still (no code-signing budget yet), so Windows SmartScreen will likely
  flag it on first run.
- **Resolved:** the backend is live at `https://gpu-cert.vercel.app` — real
  Turso DB (`gpu-cert` in a new `gpu-cert-us` group, `aws-us-east-1`, paired
  with the Vercel function's `iad1` region for a short DB hop), a real
  Ed25519 signing key, and all other production secrets are provisioned and
  set (see `~/.secrets/gpu-cert production` for the values — the signing key
  especially has no recovery if lost). Verified end-to-end against the live
  deployment: signup, login, logout, dashboard, upload-key report
  attribution, and claim-after-fact all round-trip correctly. This also
  means `client/src/report.rs`'s hardcoded `BACKEND_BASE_URL` now points at
  a real, working backend — the exe has somewhere to actually submit to
  once it's built and run.

## Real-hardware findings

First real runs happened on an RX 6600 (Windows) on 2026-08-13, and they
found real bugs rather than confirming the code worked. Worth reading before
changing any of the Vulkan paths, because two of these fail *silently* and
cost several wasted hardware runs each:

- **A descriptor pool without `FREE_DESCRIPTOR_SET` exhausts after one
  dispatch.** Freeing is a spec-defined no-op without that flag, so
  `max_sets(1)` permanently ran out on the second call.
- **Exceeding `maxStorageBufferRange` does not error.** It truncates. See the
  VRAM test note above. Diagnosed from the stored error count: 332 passes
  reporting 1,073,741,823.93 errors each is 2^30, which is exactly the
  element count that becomes unreachable when a 6.79 GiB range wraps at
  2^32. Corroborated by the timing, which implied 226 GB/s on a card whose
  theoretical peak is 224 GB/s.
- **A driver's reported limits can be useless.** This one reports
  `maxComputeWorkGroupCount[0] = 4294967295`. Chunking against a limit that
  large is the same as not chunking, which is why an earlier fix that looked
  right changed nothing at all.
- **Reproducing GPU float math on the CPU is not achievable.** See the render
  integrity note above.

The NVIDIA path was then audited statically against `nvml.h` ahead of its
first run, which found the same class of problem before it cost a run:

- **`nvmlPciInfo_t` was decoded at the wrong offsets.** Its first field is
  `busIdLegacy[16]`, not the 32-byte `busId` (which comes last), so every
  integer was read 16 bytes late and `pciDeviceId` came out of the middle of
  a string. The hardware fingerprint would have been silently meaningless on
  every NVIDIA card. Offsets are pinned by a test now, and the vendor half of
  `pciDeviceId` is checked against NVIDIA's `0x10DE` so a future layout
  mistake fails loudly instead of quietly.
- **NVML index 0 and Vulkan device 0 are not necessarily the same GPU.** On a
  laptop with switchable graphics the iGPU often enumerates first, which
  would have meant testing an Intel iGPU and certifying the GeForce beside
  it. The Vulkan device is now matched to the telemetry by (vendor, device)
  and the run refuses to start if the described card isn't there.
- **A single unsupported sensor aborted the whole run.** Optional telemetry
  now degrades instead, and PCIe link widths are read as an all-or-nothing
  pair (a good "current" with a failed "max" would have false-failed a
  healthy card).

Still unverified against real hardware: the NVIDIA path has still never
actually executed, only been audited; the full-length (non-`--fast`) protocol
has never run end to end; AMD's degraded-PCIe-link check is deliberately
inert because ADL exposes no verified max-lane-count call; and the 100°C
watchdog and the stress-telemetry thresholds in `stress-analysis.ts` remain
conservative estimates rather than calibrated numbers.
