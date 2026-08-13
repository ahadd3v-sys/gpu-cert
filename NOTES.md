# Working notes

Shared scratchpad between whoever is working on this. Newest entry at the top.
Keep the README for what the product *is*; this file is for what's currently
broken, what was tried, and why.

---

## 2026-08-13 — v0.2.0 shipped. Both root causes fixed, plus a verification surface.

Everything in the entry below is now addressed. What changed:

**VRAM test.** `vram_test.rs` allocates several buffers instead of one, each
sized at runtime to `min(maxStorageBufferRange, maxMemoryAllocationSize,
device-local heap, 1 GiB)`. Allocation failure halves and retries, then
proceeds with whatever it got, since how much VRAM is free depends on what
else is running and no reported number accounts for that. `device.rs` now
queries all three limits (maxMemoryAllocationSize via
`VkPhysicalDeviceMaintenance3Properties`), and picks the DEVICE_LOCAL memory
type on the *largest* heap rather than the first match, because AMD exposes a
small BAR-window type that can enumerate first and would have capped the test
at 256 MB. `compute.rs` hard-fails if anything ever tries to bind past
`maxStorageBufferRange` again, so the silent version of this bug cannot come
back.

**Render integrity.** Rewritten as an integer hash rendered to a
`VK_FORMAT_R32_UINT` attachment, compared bit-exactly with no epsilon. Since
a frame is now deterministic, the CPU reference is built once up front
(~0.6s) and every pixel of every frame is compared, rather than 64 sampled
points, which is what a localized ROP or framebuffer defect actually needs.
`FUR_MISMATCH_FAIL_FRACTION` is 0 to match: with no noise floor, a tolerance
would only hide defects.

**Also fixed while in here:** a missing write-visibility barrier between the
VRAM fill and verify dispatches (a fence guarantees execution finished, not
that writes left cache — a false pass was possible, which is the one outcome
this test exists to rule out); an open redirect via `?next=` on login/signup;
a login timing oracle that leaked which emails have accounts; no email
validation on signup; `account::normalize` rejecting a valid key whose first
group is literally `GPUC`; and no timeout or retry on report submission, so a
dropped packet at minute 16 threw away the whole run. Submission now retries
with backoff and parks the payload on disk for `--resubmit` if it still
fails.

**New: verification actually exists.** `verifyReportSignature` was exported
and never called, while the certificate footer claimed it was "verifiable
against GPU Cert's published signing key" — a key that was not published,
against a check that did not exist. There is now `/verify`, `/verify/:ref`,
and `/.well-known/gpu-cert-key.pem`. See the README section.

**Verified before shipping:** `cargo test` (7), `cargo clippy` clean,
`npm run check` (13 signing/tamper assertions), `npm run smoke` (19 end-to-end
assertions against a real server on a throwaway DB). The Windows exe
cross-builds to a 3.9 MB PE32+ console binary.

**Still open, and honestly unproven:** none of this has run on real hardware
yet. The prediction to check against is specific — the VRAM test should now
report **0 errors** on a healthy card, and the render test **0 mismatches**.
If the VRAM test still reports roughly 2^30 errors per pass, the segmentation
is not taking effect. And the NVIDIA path still has no real run at all.

---

## 2026-08-13 — v0.1.9's two fixes are both wrong. Don't spend a hardware run on it. (RESOLVED by v0.2.0 above)

Diagnosed from the two real RX 6600 reports already in the production Turso DB
(`d36aaf5b` v0.1.7 and `d94f925e` v0.1.8), not from a new run. Both root causes
are confirmed arithmetically against the stored numbers, and both are
**general Vulkan spec violations**, not RX 6600 quirks.

### Bug 1: the VRAM buffer exceeds `maxStorageBufferRange`. It is not the dispatch count.

`vram_test.rs` allocates one `GpuBuffer` of `vram_total * 0.85` and
`compute.rs:197` binds it with `.range(b.size)`. On the RX 6600 run that is
**7,287,183,768 bytes** in a single descriptor.

`maxStorageBufferRange` is a `uint32_t`. Binding more than it is a hard spec
violation of **VUID-VkWriteDescriptorSet-descriptorType-00333**:

> the `range` member of each element of `pBufferInfo` [...] must be less than
> or equal to `VkPhysicalDeviceLimits::maxStorageBufferRange`

The Vulkan Hardware Database reports this card at
`maxStorageBufferRange = 3758096384` and `maxMemoryAllocationSize = 3758096384`
(3.5 GiB), so **both** the allocation and the binding were over the limit.
Khronos issue #1016 has an NVIDIA driver dev confirming the 4 GiB-1 ceiling
"matches HW limitations" and that implementations will keep advertising it.

The range field truncates mod 2^32, so the shader could only reach
`7,287,183,768 mod 2^32 = 2,992,216,472` bytes = **748,054,118 elements** of
the 1,821,795,942 it was asked to cover. Fill silently discards every write
past that; verify reads back 0 and counts a mismatch. Predicted error count:

```
1,821,795,942 - 748,054,118 = 1,073,741,824   (exactly 2^30)
```

Observed: `356,482,285,544 / 332 passes = 1,073,741,823.93`. That is an exact
match, and it is why the number was suspiciously stable across two runs.

The timing corroborates it. 332 passes in 20,051 ms is 60 ms/pass. Fill+verify
over the *claimed* 6.79 GiB would be 13.58 GB in 60 ms = 226 GB/s, above this
card's 224 GB/s theoretical peak, i.e. physically impossible. Over the
*actually addressable* 2.99 GiB it is ~100 GB/s, which is ordinary.

**Why v0.1.9 does not fix it:** capping dispatches at 65535 workgroups changes
how the work is split across `vkCmdDispatch` calls. It does not change the
descriptor's range, so the shader still cannot address past 2,992,216,472
bytes. v0.1.9 will report the same ~2^30 errors per pass.

Also note v0.1.8 was a no-op for the same underlying reason: the driver
reported `maxComputeWorkGroupCount[0] = 4294967295`, so
`saturating_mul(256)` saturated and produced exactly one chunk. That is why
0.1.7 and 0.1.8 returned 356,482,285,541 and 356,482,285,544, three apart.

**Fix:** segment the tested VRAM into several buffers, each sized to
`min(maxStorageBufferRange, maxMemoryAllocationSize, 1 GiB safety cap)`, queried
from the device at runtime. Never one giant buffer.

### Bug 2: the render-integrity test cannot work as designed. Raising the epsilon will not save it.

`fur.frag` accumulates 4000 float terms and outputs `fract(acc)`. `fract` of a
large accumulator is a discontinuity: when `acc` sits near an integer, an
arbitrarily small difference flips the output between ~0.999 and ~0.000, a
delta of ~1.0. **No epsilon below 1.0 can absorb that, and epsilon >= 1.0 makes
the test vacuous.** This is a methodology failure, not a tuning problem.

The GPU/CPU divergence that feeds the discontinuity is real and unavoidable:

- `acc += sin(..) * cos(..)` is `a*b + c`, which GPU compilers freely contract
  into a single FMA. The CPU does a rounded multiply then a rounded add. These
  are different results by construction, and it compounds over 4000 iterations.
- Vulkan permits several ULP of error on `Sin`/`Cos`; CPU libm is under 1 ULP.

Working backwards from the observed rate: 361/13440 = 2.7% of samples, across
3 channels, implies an accumulated error of ~0.0045 in `acc`. That is entirely
consistent with the above. The v0.1.9 `wrapAngle` change is not wrong exactly,
it just addresses a smaller term than the one that dominates.

**Fix:** stop trying to reproduce GPU float math on the CPU. Integer ALU ops
(xor, shift, multiply, add) are bit-exact on every conformant implementation,
so the test becomes an exact comparison with zero tolerance. Render an integer
hash to a `VK_FORMAT_R32_UINT` attachment, which has mandatory
`COLOR_ATTACHMENT_BIT` support per the spec's Mandatory Format Support table,
so this is portable to any GPU, not just this one.

This also allows a much stronger test than the old 8x8 grid: with a fixed seed
the frame is deterministic, so the CPU reference can be computed once and every
subsequent frame compared in full (all 65,536 pixels, every frame) instead of
64 sampled points.

### Sources

- VUID text: `chapters/descriptorsets.adoc` in KhronosGroup/Vulkan-Docs
- Khronos/Vulkan-Docs issue #1016 (4 GiB storage buffer ceiling)
- vulkan.gpuinfo.org report id=39168 (AMD Radeon RX 6600 limits)
- Mandatory Format Support tables, `chapters/formats.adoc`
