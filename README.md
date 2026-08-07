# GPU Cert

"Carfax for used GPUs" — a hardware verification certificate for GPUs sold P2P
(r/hardwareswap, Facebook Marketplace, OLX). Full scope: see the board doc and
`hardware-verification-certificate-scope.md`.

## Product scope

Scoped deliberately to the certificate use case, not a general diagnostic
suite (there's no shortage of those — FurMark, OCCT, GpuMemTest — and we're
not trying to out-feature them). The thing nobody else in the P2P resale
space offers is a report a stranger can independently verify: signed
server-side, bound to a specific card's fingerprint, hosted at a public URL.
Buyback services (GPUsed, Cash4GPU) offer certified testing too, but only if
you sell *to them*; this stays self-serve for a seller's own listing.

## Flow

Site-first, not exe-first: log in on the website, click "Test your GPU",
download `gpu-cert.exe`, run it, it submits its report and opens your
browser back to the results page, which you can save to your account. The
exe itself is a plain console app — no GUI. The trust problem a GUI would
otherwise need to solve (a random exe reading your hardware and phoning
home looks like malware) is handled upstream instead: the only way to get
this exe is by clicking a button on a site you logged into, so the download
itself is the trust signal, not the window's appearance.

## Layout

- `client/` — Rust Windows console app. Reads NVML/ADL telemetry, runs a
  Vulkan-based stress + VRAM pattern test, computes a hardware fingerprint,
  and submits a signed report request to the backend.
- `backend/` — Hono app on Vercel (Turso for storage). Accounts
  (signup/login, JWT session cookie), ingests reports from the exe
  (unauthenticated — the exe has no browser session), lets a logged-in
  viewer claim an unowned report to their account, serves the public
  `/r/:reportId` report page and shareable badge image, and a `/dashboard`
  listing a user's claimed reports.

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

The site pages beyond the report page (home, login, signup, dashboard) are
deliberately undressed — no CSS, functional scaffolding only. Visual design
for those is being done separately; there's nothing here to fight or redo
once that lands.

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
- **NVML/ADL/Vulkan can't be exercised at all here** — no real driver, GPU,
  or Windows Vulkan ICD in this dev environment. `cargo check`/`cargo build`
  (native Linux target) and the shader→SPIR-V build step both pass, and the
  no-GPU error path was confirmed to fail cleanly, but none of the actual
  hardware-facing code paths have run against real hardware.
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
