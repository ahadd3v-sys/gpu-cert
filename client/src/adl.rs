//! AMD Display Library (ADL) bindings — the legacy C-ABI API, chosen over
//! ADLX for Phase 1 specifically to avoid writing a C++ shim just to get a
//! callable FFI surface from Rust (see the board's stack decision doc).
//! Windows-only: ADL ships as atiadlxx.dll (64-bit) alongside the AMD
//! driver.
//!
//! Struct layouts and sensor IDs below are ground-truthed against AMD's own
//! public ADL SDK (github.com/GPUOpen-LibrariesAndSDKs/display-library,
//! adl_defines.h / adl_structures.h) and cross-checked against hashcat's
//! `ext_ADL.h`/`ext_ADL.c`, which calls this exact sensor API against real
//! AMD hardware in the wild — not hand-typed from memory, since a wrong
//! struct layout here risks silently reading the *wrong* physical quantity
//! with total confidence, which is worse for a certificate product than a
//! clean failure.
//!
//! Uses the ADL2 (context-handle) API throughout rather than the older
//! global-state ADL1 API — thread-safe and the modern convention, and every
//! ADL2 call is just its ADL1 equivalent with a context handle prepended,
//! so nothing here trades away confidence for that switch.
//!
//! `ADL2_New_QueryPMLogData_Get` is the modern per-sensor telemetry call
//! (temperature, clocks, power, utilization, PCIe lanes) for RDNA and
//! later. AMD's docs mark it "less efficient" than the newer shared-memory
//! streaming API (`ADL2_Overdrive8_PMLog_ShareMemory_*`), but it's a single
//! synchronous call rather than a persistent mapped-memory session, it's
//! what hashcat itself uses against real cards, and correctness matters
//! far more here than shaving a syscall.
//!
//! Known limitation: ADL has no verified call for a card's true *maximum*
//! PCIe lane count (only the live/current lane count, via the
//! `ADL_PMLOG_BUS_LANES` sensor). Hardcoding an assumed max — e.g. "16" —
//! would be actively wrong for at least one card this project's own
//! developer tests on: the RX 6600 (non-XT) is physically/electrically an
//! x8 card, not x16. So `pcie_link_width_current` and `_max` are reported
//! equal here: the AMD path can't yet catch a real degraded-slot defect,
//! but it also can't false-fail a healthy card running at its real spec.
//! Revisit once there's a verified source for true max lanes.

#![cfg(target_os = "windows")]

use libloading::{Library, Symbol};
use std::os::raw::{c_char, c_int, c_void};

use crate::nvml::GpuTelemetry;

const ADL_LIB_NAME: &str = "atiadlxx.dll";
const ADL_OK: c_int = 0;
const ADL_MAX_PATH: usize = 256;
const ADL_PMLOG_MAX_SENSORS: usize = 256;
// PCI-SIG vendor ID for AMD/ATI is the hex value 0x1002 — but confirmed via
// a real ADL adapter dump that AdapterInfo.iVendorID reports it as the
// *decimal* number 1002 (prints as 0x03ea in hex), not the hex value 0x1002
// itself. Comparing against 0x1002 silently matched nothing on real
// hardware — every adapter (11 of them, all genuinely AMD) got filtered out
// as "not AMD."
const AMD_VENDOR_ID: c_int = 1002;

// ADL_PMLOG_SENSORS enum values (adl_defines.h). The sensors array in
// ADLPMLogDataOutput is indexed directly by these — not searched.
const PMLOG_CLK_GFXCLK: usize = 1;
const PMLOG_CLK_MEMCLK: usize = 2;
const PMLOG_TEMPERATURE_EDGE: usize = 8;
const PMLOG_INFO_ACTIVITY_GFX: usize = 19;
const PMLOG_ASIC_POWER: usize = 23;
const PMLOG_BUS_LANES: usize = 41;

type AdlContextHandle = *mut c_void;
type MallocCallback = extern "C" fn(c_int) -> *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct AdapterInfo {
    size: c_int,
    adapter_index: c_int,
    udid: [c_char; ADL_MAX_PATH],
    bus_number: c_int,
    device_number: c_int,
    function_number: c_int,
    vendor_id: c_int,
    adapter_name: [c_char; ADL_MAX_PATH],
    display_name: [c_char; ADL_MAX_PATH],
    present: c_int,
    exist: c_int,
    driver_path: [c_char; ADL_MAX_PATH],
    driver_path_ext: [c_char; ADL_MAX_PATH],
    pnp_string: [c_char; ADL_MAX_PATH],
    os_display_index: c_int,
}

impl AdapterInfo {
    fn zeroed() -> Self {
        AdapterInfo {
            size: std::mem::size_of::<AdapterInfo>() as c_int,
            adapter_index: 0,
            udid: [0; ADL_MAX_PATH],
            bus_number: 0,
            device_number: 0,
            function_number: 0,
            vendor_id: 0,
            adapter_name: [0; ADL_MAX_PATH],
            display_name: [0; ADL_MAX_PATH],
            present: 0,
            exist: 0,
            driver_path: [0; ADL_MAX_PATH],
            driver_path_ext: [0; ADL_MAX_PATH],
            pnp_string: [0; ADL_MAX_PATH],
            os_display_index: 0,
        }
    }
}

#[repr(C)]
struct AdlMemoryInfo2 {
    memory_size: i64,
    memory_type: [c_char; ADL_MAX_PATH],
    memory_bandwidth: i64,
    hyper_memory_size: i64,
    invisible_memory_size: i64,
    visible_memory_size: i64,
}

impl AdlMemoryInfo2 {
    fn zeroed() -> Self {
        AdlMemoryInfo2 {
            memory_size: 0,
            memory_type: [0; ADL_MAX_PATH],
            memory_bandwidth: 0,
            hyper_memory_size: 0,
            invisible_memory_size: 0,
            visible_memory_size: 0,
        }
    }
}

#[repr(C)]
struct AdlBiosInfo {
    part_number: [c_char; ADL_MAX_PATH],
    version: [c_char; ADL_MAX_PATH],
    date: [c_char; ADL_MAX_PATH],
}

impl AdlBiosInfo {
    fn zeroed() -> Self {
        AdlBiosInfo {
            part_number: [0; ADL_MAX_PATH],
            version: [0; ADL_MAX_PATH],
            date: [0; ADL_MAX_PATH],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AdlSingleSensorData {
    supported: c_int,
    value: c_int,
}

#[repr(C)]
struct AdlPmLogDataOutput {
    size: c_int,
    sensors: [AdlSingleSensorData; ADL_PMLOG_MAX_SENSORS],
}

impl AdlPmLogDataOutput {
    fn zeroed() -> Self {
        AdlPmLogDataOutput {
            size: std::mem::size_of::<AdlPmLogDataOutput>() as c_int,
            sensors: [AdlSingleSensorData { supported: 0, value: 0 }; ADL_PMLOG_MAX_SENSORS],
        }
    }
}

extern "C" fn adl_main_memory_alloc(size: c_int) -> *mut c_void {
    unsafe { libc_alloc(size.max(0) as usize) }
}

// Minimal malloc shim so we don't need to pull in the `libc` crate for one
// allocation callback ADL requires but never calls at high frequency.
unsafe fn libc_alloc(size: usize) -> *mut c_void {
    let layout = std::alloc::Layout::from_size_align(size.max(1), 16).unwrap();
    unsafe { std::alloc::alloc(layout) as *mut c_void }
}

fn cstr_field(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// AMD ADL exposes the PCI device ID via the Windows PnP device instance
/// string (`PCI\VEN_1002&DEV_73FF&SUBSYS_...`), not as a plain integer
/// field the way NVML does — parsed out here rather than guessing another
/// ADL call for it.
fn parse_pci_device_id(pnp_string: &str) -> Option<u32> {
    let idx = pnp_string.find("DEV_")?;
    let hex = pnp_string.get(idx + 4..idx + 8)?;
    u32::from_str_radix(hex, 16).ok()
}

pub struct Adl {
    _lib: Library,
    context: AdlContextHandle,
    main_control_destroy: Symbol<'static, unsafe extern "C" fn(AdlContextHandle) -> c_int>,
    adapter_number_of_adapters_get: Symbol<'static, unsafe extern "C" fn(AdlContextHandle, *mut c_int) -> c_int>,
    adapter_adapter_info_get: Symbol<'static, unsafe extern "C" fn(AdlContextHandle, *mut AdapterInfo, c_int) -> c_int>,
    adapter_memory_info2_get: Symbol<'static, unsafe extern "C" fn(AdlContextHandle, c_int, *mut AdlMemoryInfo2) -> c_int>,
    // Optional, not required: not every driver version exports this ADL2
    // wrapper (confirmed missing on at least one real RX 6600 system), and
    // VBIOS is fingerprint-quality-only, not safety- or verdict-critical —
    // a missing symbol here shouldn't take down the whole ADL path the way
    // a missing PMLog or adapter-enumeration symbol should.
    adapter_vbios_info_get: Option<Symbol<'static, unsafe extern "C" fn(AdlContextHandle, c_int, *mut AdlBiosInfo) -> c_int>>,
    new_query_pmlog_data_get: Symbol<'static, unsafe extern "C" fn(AdlContextHandle, c_int, *mut AdlPmLogDataOutput) -> c_int>,
    adapter_index: c_int,
}

impl Adl {
    /// Loads atiadlxx.dll, creates an ADL2 context, and picks the first
    /// present AMD adapter. Returns an error (not a panic) if there's no AMD
    /// driver or no AMD adapter — matching `Nvml::load`, an AMD card is not
    /// a precondition for running the client, only for this path.
    pub fn load() -> anyhow::Result<Self> {
        unsafe {
            let lib = Library::new(ADL_LIB_NAME)
                .map_err(|e| anyhow::anyhow!("failed to load {ADL_LIB_NAME}: {e}"))?;

            macro_rules! sym {
                ($name:literal, $ty:ty) => {
                    std::mem::transmute::<Symbol<'_, $ty>, Symbol<'static, $ty>>(
                        lib.get::<$ty>($name)
                            .map_err(|e| anyhow::anyhow!("missing ADL symbol {}: {e}", stringify!($name)))?,
                    )
                };
            }
            // Same lookup, but a missing symbol degrades to `None` instead
            // of aborting `load()` — for optional, non-safety-critical data.
            macro_rules! opt_sym {
                ($name:literal, $ty:ty) => {
                    lib.get::<$ty>($name)
                        .ok()
                        .map(|s| std::mem::transmute::<Symbol<'_, $ty>, Symbol<'static, $ty>>(s))
                };
            }

            let main_control_create = sym!(
                b"ADL2_Main_Control_Create\0",
                unsafe extern "C" fn(MallocCallback, c_int, *mut AdlContextHandle) -> c_int
            );
            let main_control_destroy = sym!(b"ADL2_Main_Control_Destroy\0", unsafe extern "C" fn(AdlContextHandle) -> c_int);
            let adapter_number_of_adapters_get = sym!(
                b"ADL2_Adapter_NumberOfAdapters_Get\0",
                unsafe extern "C" fn(AdlContextHandle, *mut c_int) -> c_int
            );
            let adapter_adapter_info_get = sym!(
                b"ADL2_Adapter_AdapterInfo_Get\0",
                unsafe extern "C" fn(AdlContextHandle, *mut AdapterInfo, c_int) -> c_int
            );
            let adapter_memory_info2_get = sym!(
                b"ADL2_Adapter_MemoryInfo2_Get\0",
                unsafe extern "C" fn(AdlContextHandle, c_int, *mut AdlMemoryInfo2) -> c_int
            );
            let adapter_vbios_info_get = opt_sym!(
                b"ADL2_Adapter_VBIOSInfo_Get\0",
                unsafe extern "C" fn(AdlContextHandle, c_int, *mut AdlBiosInfo) -> c_int
            );
            if adapter_vbios_info_get.is_none() {
                println!("(ADL2_Adapter_VBIOSInfo_Get not available on this driver — VBIOS version will report as \"unknown\")");
            }
            let new_query_pmlog_data_get = sym!(
                b"ADL2_New_QueryPMLogData_Get\0",
                unsafe extern "C" fn(AdlContextHandle, c_int, *mut AdlPmLogDataOutput) -> c_int
            );

            let mut context: AdlContextHandle = std::ptr::null_mut();
            // 1 = enumerate connected adapters only.
            let rc = main_control_create(adl_main_memory_alloc, 1, &mut context);
            if rc != ADL_OK {
                anyhow::bail!("ADL2_Main_Control_Create failed: rc={rc}");
            }

            let mut count: c_int = 0;
            check((adapter_number_of_adapters_get)(context, &mut count), "ADL2_Adapter_NumberOfAdapters_Get")?;
            if count <= 0 {
                let _ = main_control_destroy(context);
                anyhow::bail!("no ADL adapters found");
            }

            let mut infos = vec![AdapterInfo::zeroed(); count as usize];
            check(
                (adapter_adapter_info_get)(
                    context,
                    infos.as_mut_ptr(),
                    (std::mem::size_of::<AdapterInfo>() * infos.len()) as c_int,
                ),
                "ADL2_Adapter_AdapterInfo_Get",
            )?;

            // Deliberately NOT gated on ADL_Adapter_Active_Get: "active"
            // there tracks display-output/Eyefinity topology state, not
            // whether the ASIC itself is present and queryable — a
            // perfectly normal single-monitor desktop card can read back
            // inactive depending on which adapter entry ADL considers to
            // own the active display path. GPU-Z and similar tools don't
            // gate sensor reads on it either; presence is enough.
            //
            // A real system can enumerate many AMD "adapter" entries for
            // one physical GPU (one per display head/output path) plus a
            // separate entry for an integrated APU, if present — confirmed
            // on real hardware: 11 entries for a single discrete card. The
            // first present+AMD match isn't reliable, so instead: rank
            // every candidate by reported VRAM (a discrete card reports
            // far more than an iGPU) and take the first one, in that order,
            // that actually answers a live PMLog temperature query — the
            // same read the safety watchdog depends on every tick, so an
            // adapter entry that can't answer it isn't usable here even if
            // it otherwise looks like the right card.
            let mut candidates: Vec<(c_int, i64, String)> = Vec::new();
            for info in &infos {
                let name = cstr_field(&info.adapter_name);
                println!(
                    "  ADL adapter {}: vendor={} present={} name={name:?}",
                    info.adapter_index, info.vendor_id, info.present,
                );
                if info.vendor_id != AMD_VENDOR_ID || info.present == 0 {
                    continue;
                }
                let mut mem = AdlMemoryInfo2::zeroed();
                if (adapter_memory_info2_get)(context, info.adapter_index, &mut mem) == ADL_OK {
                    candidates.push((info.adapter_index, mem.memory_size, name));
                }
            }
            candidates.sort_by_key(|c| std::cmp::Reverse(c.1));

            let mut chosen: Option<c_int> = None;
            for (idx, vram, name) in &candidates {
                let mut pmlog = AdlPmLogDataOutput::zeroed();
                let has_temp = (new_query_pmlog_data_get)(context, *idx, &mut pmlog) == ADL_OK
                    && pmlog.sensors.get(PMLOG_TEMPERATURE_EDGE).is_some_and(|s| s.supported != 0);
                println!(
                    "  candidate adapter {idx} ({name:?}, {} MB reported VRAM): temperature sensor {}",
                    vram / 1_048_576,
                    if has_temp { "available" } else { "unavailable" },
                );
                if has_temp {
                    chosen = Some(*idx);
                    break;
                }
            }

            let adapter_index = match chosen {
                Some(idx) => idx,
                None => {
                    let _ = main_control_destroy(context);
                    anyhow::bail!(
                        "found {} AMD adapter candidate(s) among {count} ADL adapter(s), but none answered \
                         a live temperature query — see the adapter list printed above",
                        candidates.len()
                    );
                }
            };

            Ok(Adl {
                _lib: lib,
                context,
                main_control_destroy,
                adapter_number_of_adapters_get,
                adapter_adapter_info_get,
                adapter_memory_info2_get,
                adapter_vbios_info_get,
                new_query_pmlog_data_get,
                adapter_index,
            })
        }
    }

    pub fn read_primary_gpu(&self) -> anyhow::Result<GpuTelemetry> {
        unsafe {
            let mut count: c_int = 0;
            check(
                (self.adapter_number_of_adapters_get)(self.context, &mut count),
                "ADL2_Adapter_NumberOfAdapters_Get",
            )?;
            let mut infos = vec![AdapterInfo::zeroed(); count.max(0) as usize];
            check(
                (self.adapter_adapter_info_get)(
                    self.context,
                    infos.as_mut_ptr(),
                    (std::mem::size_of::<AdapterInfo>() * infos.len()) as c_int,
                ),
                "ADL2_Adapter_AdapterInfo_Get",
            )?;
            let info = infos
                .iter()
                .find(|i| i.adapter_index == self.adapter_index)
                .ok_or_else(|| anyhow::anyhow!("AMD adapter {} disappeared between calls", self.adapter_index))?;

            let name = cstr_field(&info.adapter_name);
            let udid = cstr_field(&info.udid);
            let pnp_string = cstr_field(&info.pnp_string);
            // Non-fatal: fingerprinting still works (as a 3-of-4-field
            // tuple) if this comes back 0, just weaker.
            let pci_device_id = parse_pci_device_id(&pnp_string).unwrap_or(0);

            let mut mem = AdlMemoryInfo2::zeroed();
            check(
                (self.adapter_memory_info2_get)(self.context, self.adapter_index, &mut mem),
                "ADL2_Adapter_MemoryInfo2_Get",
            )?;

            let vbios_version = match &self.adapter_vbios_info_get {
                Some(f) => {
                    let mut bios = AdlBiosInfo::zeroed();
                    if f(self.context, self.adapter_index, &mut bios) == ADL_OK {
                        cstr_field(&bios.version)
                    } else {
                        // Not safety-critical, only fingerprint quality —
                        // degrade rather than fail the whole read over this.
                        String::from("unknown")
                    }
                }
                None => String::from("unknown"),
            };

            let mut pmlog = AdlPmLogDataOutput::zeroed();
            check(
                (self.new_query_pmlog_data_get)(self.context, self.adapter_index, &mut pmlog),
                "ADL2_New_QueryPMLogData_Get",
            )?;

            let sensor = |idx: usize| -> Option<i32> {
                let s = pmlog.sensors.get(idx)?;
                if s.supported != 0 {
                    Some(s.value)
                } else {
                    None
                }
            };

            // Temperature is safety-critical (the stress-test watchdog needs
            // it every tick to abort on overheat) — refuse to proceed rather
            // than silently run a load test with no thermal safety net.
            let temperature_c = sensor(PMLOG_TEMPERATURE_EDGE).ok_or_else(|| {
                anyhow::anyhow!(
                    "GPU temperature sensor not supported/reported by this card — refusing to run \
                     without a working safety watchdog. Please report this (device: {name})."
                )
            })?;
            if !(0..=150).contains(&temperature_c) {
                anyhow::bail!(
                    "GPU temperature sensor returned an implausible reading ({temperature_c}°C) — \
                     treating it as unreliable rather than trusting it."
                );
            }

            let graphics_clock_mhz = sensor(PMLOG_CLK_GFXCLK).unwrap_or(0).max(0) as u32;
            let memory_clock_mhz = sensor(PMLOG_CLK_MEMCLK).unwrap_or(0).max(0) as u32;
            let utilization_pct = sensor(PMLOG_INFO_ACTIVITY_GFX).unwrap_or(0).clamp(0, 100) as u32;
            // ASIC_POWER is reported in whole watts; GpuTelemetry wants mW.
            let power_draw_mw = (sensor(PMLOG_ASIC_POWER).unwrap_or(0).max(0) as u32).saturating_mul(1000);
            // See module docs: current == max is deliberate, not a bug.
            let pcie_lanes = sensor(PMLOG_BUS_LANES).unwrap_or(0).max(0) as u32;

            Ok(GpuTelemetry {
                uuid: udid,
                name,
                pci_device_id,
                // The real PCI-SIG value, not ADL's `iVendorID`. Those are
                // not the same number here: ADL reports the vendor as the
                // decimal 1002 (see AMD_VENDOR_ID above), while Vulkan's
                // `VkPhysicalDeviceProperties::vendorID` reports the actual
                // hex 0x1002 that this is matched against.
                pci_vendor_id: 0x1002,
                vbios_version,
                vram_total_bytes: mem.memory_size.max(0) as u64,
                temperature_c: temperature_c as u32,
                power_draw_mw,
                graphics_clock_mhz,
                memory_clock_mhz,
                utilization_pct,
                pcie_link_width_current: pcie_lanes,
                pcie_link_width_max: pcie_lanes,
            })
        }
    }
}

impl Drop for Adl {
    fn drop(&mut self) {
        unsafe {
            let _ = (self.main_control_destroy)(self.context);
        }
    }
}

fn check(rc: c_int, call: &str) -> anyhow::Result<()> {
    if rc == ADL_OK {
        Ok(())
    } else {
        anyhow::bail!("{call} failed: rc={rc}")
    }
}
