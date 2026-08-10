//! Shared temperature safety ceiling for every sustained-load test (stress,
//! VRAM, fur render). This is a software watchdog layered on top of the
//! GPU's own firmware-level thermal/power protections, which remain the
//! primary safeguard and can't be disabled by user-mode code — same posture
//! as FurMark/OCCT/memtest_vulkan: abort before the danger zone rather than
//! trusting a fixed test duration to always be safe. 100°C leaves real
//! margin below where consumer GPUs typically hit hardware over-temperature
//! shutdown (~100-110°C depending on model).
pub const SAFETY_ABORT_TEMP_C: u32 = 100;

pub fn is_temp_unsafe(temp_c: u32) -> bool {
    temp_c >= SAFETY_ABORT_TEMP_C
}
