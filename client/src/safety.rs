//! Shared temperature safety ceiling for every sustained-load test (stress,
//! VRAM, fur render). This is a software watchdog layered on top of the GPU's
//! own firmware-level thermal/power protections, which remain the primary
//! safeguard and can't be disabled by user-mode code, same posture as
//! FurMark/OCCT/memtest_vulkan: abort before the danger zone rather than
//! trusting a fixed test duration to always be safe.
//!
//! The limit that matters is the hotspot, not the edge.
//!
//! Until this was split the watchdog compared 100 C against whatever single
//! temperature the vendor backend happened to return, which on AMD is the edge
//! sensor. On RDNA the hotspot runs 25 to 35 C above edge (a healthy RX 9070 XT
//! reads roughly 50 C edge against 80 C hotspot), and AMD's own junction limit
//! is around 110 C. So a 100 C edge threshold corresponds to something like
//! 125 to 135 C at the junction: the watchdog would essentially never fire
//! before the card was already past the limit it exists to respect.

/// Hotspot ceiling, a little under AMD's ~110 C junction limit so the abort
/// lands before the card's own throttling rather than after it.
pub const SAFETY_ABORT_HOTSPOT_C: u32 = 105;

/// Edge ceiling, used only when no hotspot sensor is available. Unchanged, and
/// deliberately conservative, because on a card that reports edge alone there
/// is no way to know how far above it the junction is sitting.
pub const SAFETY_ABORT_TEMP_C: u32 = 100;

/// True when either reading is past its own ceiling.
///
/// Both are checked rather than only the better one: a card reporting a sane
/// hotspot and an implausible edge has something wrong with it either way, and
/// stopping is the cheap option.
pub fn is_unsafe(edge_c: u32, hotspot_c: Option<u32>) -> bool {
    edge_c >= SAFETY_ABORT_TEMP_C || hotspot_c.is_some_and(|h| h >= SAFETY_ABORT_HOTSPOT_C)
}

/// The edge check on its own. Not used by the run loops any more, which all go
/// through `is_unsafe`, but kept as the thing that expresses what the edge
/// ceiling means, and used by the tests to show the two are not the same check.
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_temp_unsafe(temp_c: u32) -> bool {
    temp_c >= SAFETY_ABORT_TEMP_C
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotspot_trips_before_edge_would() {
        // The case the split exists for: a healthy-looking edge with a junction
        // already past its limit. The old check saw 78 and carried on.
        assert!(is_unsafe(78, Some(106)));
        assert!(!is_temp_unsafe(78));
    }

    #[test]
    fn edge_still_guards_a_card_with_no_hotspot_sensor() {
        assert!(is_unsafe(100, None));
        assert!(!is_unsafe(99, None));
    }

    #[test]
    fn a_normal_rdna_delta_is_not_an_abort() {
        // 50 C edge against 80 C hotspot is a healthy RX 9070 XT.
        assert!(!is_unsafe(50, Some(80)));
    }
}
