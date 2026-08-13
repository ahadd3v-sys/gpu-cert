//! Dynamic-load wrapper around NVIDIA's NVML (nvml.dll on Windows,
//! libnvidia-ml.so on Linux — loaded by path here purely so this module can
//! `cargo check` cross-platform during development; the shipped client only
//! ever runs on Windows).
//!
//! We `libloading::Library::new` the driver's own copy at runtime rather
//! than linking against a bundled nvml.lib, matching how MSI Afterburner /
//! HWiNFO do it and sidestepping NVML redistribution questions entirely.
//!
//! ECC/memory-error counters are intentionally NOT read here: they're
//! unsupported on consumer GeForce cards (only enabled by default on
//! Quadro/RTX PRO/datacenter parts), which is exactly why the Vulkan VRAM
//! pattern test in `vulkan::vram_test` exists — NVML telemetry alone cannot
//! see mining-induced VRAM degradation on the cards this product targets.

use libloading::{Library, Symbol};
use std::ffi::{c_char, c_uint, CStr};
use std::os::raw::c_void;

#[cfg(target_os = "windows")]
const NVML_LIB_NAME: &str = "nvml.dll";
#[cfg(not(target_os = "windows"))]
const NVML_LIB_NAME: &str = "libnvidia-ml.so.1";

const NVML_SUCCESS: i32 = 0;
const NVML_DEVICE_UUID_BUFFER_SIZE: usize = 80;
const NVML_DEVICE_VBIOS_VERSION_BUFFER_SIZE: usize = 32;
const NVML_DEVICE_NAME_V2_BUFFER_SIZE: usize = 96;
const NVML_DEVICE_PCI_BUS_ID_BUFFER_SIZE: usize = 32;
const NVML_DEVICE_PCI_BUS_ID_BUFFER_V2_SIZE: usize = 16;

/// PCI-SIG vendor ID for NVIDIA. Used to confirm the Vulkan device the tests
/// actually run against is the same card NVML is reporting telemetry for.
pub const NVIDIA_VENDOR_ID: u32 = 0x10DE;

/// Turns an `nvmlReturn_t` into something a person can act on. A bare
/// "rc=3" tells whoever is running this nothing; "not supported on this
/// device" tells them it is their card, not a broken build.
fn nvml_error_name(rc: i32) -> &'static str {
    match rc {
        1 => "NVML was not initialized",
        2 => "invalid argument",
        3 => "not supported on this device",
        4 => "no permission",
        6 => "not found",
        7 => "insufficient buffer size",
        8 => "external power cables not properly attached",
        9 => "NVIDIA driver is not loaded",
        10 => "timeout",
        11 => "kernel interrupt issue with the GPU",
        12 => "NVML shared library not found",
        13 => "this driver's NVML doesn't implement that function",
        14 => "corrupted infoROM",
        15 => "the GPU has fallen off the bus",
        16 => "the GPU requires a reset",
        17 => "the GPU has been blocked by the operating system",
        18 => "driver/library version mismatch",
        19 => "the GPU is in use",
        20 => "insufficient memory",
        21 => "no data",
        _ => "unknown error",
    }
}

type NvmlDevice = *mut c_void;

/// Mirrors `nvmlPciInfo_t` from nvml.h exactly. The field order matters more
/// than it looks: the struct opens with `busIdLegacy`, which is
/// `NVML_DEVICE_PCI_BUS_ID_BUFFER_V2_SIZE` = **16** bytes, and the 32-byte
/// `busId` comes *last*, after the integers.
///
/// This was previously declared with a 32-byte buffer first, which pushed
/// every integer 16 bytes past where NVML writes it. `pci_device_id` then
/// read from inside the trailing `busId` string, so the value feeding the
/// hardware fingerprint was four bytes of ASCII bus-address text
/// reinterpreted as a number. Nothing would have errored; the fingerprint
/// would just have been quietly meaningless on every NVIDIA card.
///
/// ```text
/// offset  field
///      0  busIdLegacy[16]
///     16  domain
///     20  bus
///     24  device
///     28  pciDeviceId
///     32  pciSubSystemId
///     36  busId[32]
///     68  (end)
/// ```
#[repr(C)]
struct NvmlPciInfo {
    bus_id_legacy: [c_char; NVML_DEVICE_PCI_BUS_ID_BUFFER_V2_SIZE],
    domain: c_uint,
    bus: c_uint,
    device: c_uint,
    /// The combined 16-bit device id and 16-bit vendor id, device in the
    /// high half. Not the bare device id, which is what the certificate
    /// wants and what the AMD path already produces.
    pci_device_id: c_uint,
    pci_sub_system_id: c_uint,
    bus_id: [c_char; NVML_DEVICE_PCI_BUS_ID_BUFFER_SIZE],
    /// Slack for a future NVML revision appending fields. NVML writes only
    /// as much as its own struct defines, so over-allocating is free
    /// insurance against a newer driver writing past what this knows about.
    _reserved: [u8; 64],
}

#[repr(C)]
struct NvmlMemoryInfo {
    total: u64,
    free: u64,
    used: u64,
}

#[repr(C)]
struct NvmlUtilization {
    gpu: c_uint,
    memory: c_uint,
}

#[repr(C)]
#[derive(Debug, Default, serde::Serialize)]
pub struct GpuTelemetry {
    pub uuid: String,
    pub name: String,
    /// The bare 16-bit PCI device ID (e.g. `0x2786`), normalized to mean the
    /// same thing on both vendor backends. NVML reports device and vendor
    /// packed into one 32-bit value and ADL parses the device ID out of a
    /// PnP string, so without normalizing here the certificate's "PCI Device
    /// ID" row would be an 8-digit number on NVIDIA and a 4-digit one on AMD.
    pub pci_device_id: u32,
    /// PCI-SIG vendor ID. Not shown on the certificate; used to verify the
    /// Vulkan device under test is the card this telemetry describes.
    pub pci_vendor_id: u32,
    pub vbios_version: String,
    pub vram_total_bytes: u64,
    pub temperature_c: u32,
    pub power_draw_mw: u32,
    pub graphics_clock_mhz: u32,
    pub memory_clock_mhz: u32,
    /// GPU core utilization, 0-100. Not a stress-test result on its own —
    /// it's what "load" means when the GUI shows a live reading during the
    /// test — but it's a real NVML value, not a derived/guessed number.
    pub utilization_pct: u32,
    /// Current vs. max-supported PCIe lane width (e.g. 16 vs 16, or 8 vs
    /// 16 for a degraded link). A card stuck below its max width — bent
    /// connector, bad slot, damaged pins, riser cable fault — is a real
    /// resale-relevant defect that no compute/VRAM test would ever surface.
    pub pcie_link_width_current: u32,
    pub pcie_link_width_max: u32,
}

pub struct Nvml {
    _lib: Library,
    init_v2: Symbol<'static, unsafe extern "C" fn() -> i32>,
    shutdown: Symbol<'static, unsafe extern "C" fn() -> i32>,
    device_get_count: Symbol<'static, unsafe extern "C" fn(*mut c_uint) -> i32>,
    device_get_handle: Symbol<'static, unsafe extern "C" fn(c_uint, *mut NvmlDevice) -> i32>,
    device_get_uuid: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> i32>,
    device_get_name: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> i32>,
    device_get_pci_info: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut NvmlPciInfo) -> i32>,
    device_get_vbios: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> i32>,
    device_get_memory_info: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut NvmlMemoryInfo) -> i32>,
    device_get_temperature: Symbol<'static, unsafe extern "C" fn(NvmlDevice, c_uint, *mut c_uint) -> i32>,
    device_get_power_usage: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut c_uint) -> i32>,
    device_get_clock_info: Symbol<'static, unsafe extern "C" fn(NvmlDevice, c_uint, *mut c_uint) -> i32>,
    device_get_utilization_rates: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> i32>,
    device_get_curr_pcie_link_width: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut c_uint) -> i32>,
    device_get_max_pcie_link_width: Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut c_uint) -> i32>,
}

// NVML_TEMPERATURE_GPU
const NVML_TEMPERATURE_GPU: c_uint = 0;
// NVML_CLOCK_GRAPHICS / NVML_CLOCK_MEM
const NVML_CLOCK_GRAPHICS: c_uint = 0;
const NVML_CLOCK_MEM: c_uint = 2;

impl Nvml {
    /// Loads nvml.dll from the driver's search path and resolves the
    /// handful of symbols this client needs. Returns an error (not a
    /// panic) if the driver isn't present — an Nvidia card is not a
    /// precondition for running the client, only for this code path.
    pub fn load() -> anyhow::Result<Self> {
        unsafe {
            let lib = Library::new(NVML_LIB_NAME)
                .map_err(|e| anyhow::anyhow!("failed to load {NVML_LIB_NAME}: {e}"))?;

            // Symbols borrow from `lib`; transmute the lifetime to 'static
            // since `lib` is stored alongside them in the same struct and
            // dropped last (declaration order = drop order in Rust).
            //
            // `$ty` is required, not inferred: `lib.get::<T>` has no way to
            // pick `T` on its own, and a bare `let x = sym!(...)` gives the
            // compiler no expected type to unify against until the struct
            // literal below, by which point it's too late (E0282).
            macro_rules! sym {
                ($name:literal, $ty:ty) => {
                    std::mem::transmute::<Symbol<'_, $ty>, Symbol<'static, $ty>>(
                        lib.get::<$ty>($name)
                            .map_err(|e| anyhow::anyhow!("missing NVML symbol {}: {e}", stringify!($name)))?,
                    )
                };
            }

            let init_v2 = sym!(b"nvmlInit_v2\0", unsafe extern "C" fn() -> i32);
            let shutdown = sym!(b"nvmlShutdown\0", unsafe extern "C" fn() -> i32);
            let device_get_count = sym!(b"nvmlDeviceGetCount_v2\0", unsafe extern "C" fn(*mut c_uint) -> i32);
            let device_get_handle = sym!(b"nvmlDeviceGetHandleByIndex_v2\0", unsafe extern "C" fn(c_uint, *mut NvmlDevice) -> i32);
            let device_get_uuid = sym!(b"nvmlDeviceGetUUID\0", unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> i32);
            let device_get_name = sym!(b"nvmlDeviceGetName\0", unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> i32);
            let device_get_pci_info = sym!(b"nvmlDeviceGetPciInfo_v3\0", unsafe extern "C" fn(NvmlDevice, *mut NvmlPciInfo) -> i32);
            let device_get_vbios = sym!(b"nvmlDeviceGetVbiosVersion\0", unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> i32);
            let device_get_memory_info = sym!(b"nvmlDeviceGetMemoryInfo\0", unsafe extern "C" fn(NvmlDevice, *mut NvmlMemoryInfo) -> i32);
            let device_get_temperature = sym!(b"nvmlDeviceGetTemperature\0", unsafe extern "C" fn(NvmlDevice, c_uint, *mut c_uint) -> i32);
            let device_get_power_usage = sym!(b"nvmlDeviceGetPowerUsage\0", unsafe extern "C" fn(NvmlDevice, *mut c_uint) -> i32);
            let device_get_clock_info = sym!(b"nvmlDeviceGetClockInfo\0", unsafe extern "C" fn(NvmlDevice, c_uint, *mut c_uint) -> i32);
            let device_get_utilization_rates = sym!(b"nvmlDeviceGetUtilizationRates\0", unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> i32);
            let device_get_curr_pcie_link_width = sym!(b"nvmlDeviceGetCurrPcieLinkWidth\0", unsafe extern "C" fn(NvmlDevice, *mut c_uint) -> i32);
            let device_get_max_pcie_link_width = sym!(b"nvmlDeviceGetMaxPcieLinkWidth\0", unsafe extern "C" fn(NvmlDevice, *mut c_uint) -> i32);

            let nvml = Nvml {
                _lib: lib,
                init_v2,
                shutdown,
                device_get_count,
                device_get_handle,
                device_get_uuid,
                device_get_name,
                device_get_pci_info,
                device_get_vbios,
                device_get_memory_info,
                device_get_temperature,
                device_get_power_usage,
                device_get_clock_info,
                device_get_utilization_rates,
                device_get_curr_pcie_link_width,
                device_get_max_pcie_link_width,
            };

            let rc = (nvml.init_v2)();
            if rc != NVML_SUCCESS {
                anyhow::bail!("nvmlInit_v2 failed: rc={rc}");
            }

            Ok(nvml)
        }
    }

    /// Reads telemetry for GPU index 0. Multi-GPU handling (letting the
    /// user pick which card is being certified) is a product decision, not
    /// a stack decision — deferred, see report.rs TODO.
    pub fn read_primary_gpu(&self) -> anyhow::Result<GpuTelemetry> {
        unsafe {
            let mut count: c_uint = 0;
            check((self.device_get_count)(&mut count))?;
            if count == 0 {
                anyhow::bail!("no NVIDIA GPUs found");
            }

            let mut device: NvmlDevice = std::ptr::null_mut();
            check((self.device_get_handle)(0, &mut device))?;

            // Identity, and the temperature the safety watchdog depends on,
            // are required: without them there is nothing to put on a
            // certificate, and no way to stop before cooking the card.
            let uuid = self.read_string(device, &self.device_get_uuid, NVML_DEVICE_UUID_BUFFER_SIZE)?;
            let name =
                self.read_string(device, &self.device_get_name, NVML_DEVICE_NAME_V2_BUFFER_SIZE)?;

            let mut pci = NvmlPciInfo {
                bus_id_legacy: [0; NVML_DEVICE_PCI_BUS_ID_BUFFER_V2_SIZE],
                domain: 0,
                bus: 0,
                device: 0,
                pci_device_id: 0,
                pci_sub_system_id: 0,
                bus_id: [0; NVML_DEVICE_PCI_BUS_ID_BUFFER_SIZE],
                _reserved: [0; 64],
            };
            check((self.device_get_pci_info)(device, &mut pci))?;

            // A self-check on the FFI layout, not on the hardware. The low
            // half of pciDeviceId is the PCI vendor ID, and on an NVML device
            // it can only ever be NVIDIA's. If it isn't, this struct's fields
            // are being read at the wrong offsets, which is precisely the bug
            // that shipped here before (a 32-byte leading buffer where nvml.h
            // has 16). That version failed silently and poisoned the hardware
            // fingerprint, so it fails loudly now.
            let vendor_id = pci.pci_device_id & 0xFFFF;
            if vendor_id != NVIDIA_VENDOR_ID {
                anyhow::bail!(
                    "NVML returned PCI vendor 0x{vendor_id:04X}, expected NVIDIA's 0x{NVIDIA_VENDOR_ID:04X}. \
                     This means nvmlPciInfo_t is being decoded at the wrong offsets, not that the card is unusual."
                );
            }

            let mut mem = NvmlMemoryInfo { total: 0, free: 0, used: 0 };
            check((self.device_get_memory_info)(device, &mut mem))?;

            let mut temp: c_uint = 0;
            check((self.device_get_temperature)(device, NVML_TEMPERATURE_GPU, &mut temp))?;

            // Everything below is telemetry the report is richer for having
            // and still valid without. Aborting a 16-minute run because one
            // optional sensor returned NOT_SUPPORTED would be the same
            // mistake the AMD path already made once with VBIOS version.
            // The backend's scoring already treats a zero clock series as
            // "no data" rather than as a failure.
            let power = self.read_optional_uint(|out| (self.device_get_power_usage)(device, out));
            let gfx_clock = self
                .read_optional_uint(|out| (self.device_get_clock_info)(device, NVML_CLOCK_GRAPHICS, out));
            let mem_clock = self
                .read_optional_uint(|out| (self.device_get_clock_info)(device, NVML_CLOCK_MEM, out));

            let mut utilization = NvmlUtilization { gpu: 0, memory: 0 };
            if (self.device_get_utilization_rates)(device, &mut utilization) != NVML_SUCCESS {
                utilization = NvmlUtilization { gpu: 0, memory: 0 };
            }

            let vbios_version = self
                .read_string(device, &self.device_get_vbios, NVML_DEVICE_VBIOS_VERSION_BUFFER_SIZE)
                .unwrap_or_else(|_| "unknown".to_string());

            // Read as a pair, all-or-nothing. Taken independently, a
            // successful "current = 8" alongside a failed "max = 0" would
            // read as a card whose link is fine, while a failed current
            // against a good max would report x0 of x16 and fail a healthy
            // card outright. Neither known is the only honest state.
            let pcie_current =
                self.read_optional_uint(|out| (self.device_get_curr_pcie_link_width)(device, out));
            let pcie_max =
                self.read_optional_uint(|out| (self.device_get_max_pcie_link_width)(device, out));
            let (pcie_current, pcie_max) = match (pcie_current, pcie_max) {
                (Some(c), Some(m)) => (c, m),
                _ => (0, 0),
            };

            Ok(GpuTelemetry {
                uuid,
                name,
                // High half is the device ID, low half the vendor ID.
                pci_device_id: pci.pci_device_id >> 16,
                pci_vendor_id: pci.pci_device_id & 0xFFFF,
                vbios_version,
                vram_total_bytes: mem.total,
                temperature_c: temp,
                power_draw_mw: power.unwrap_or(0),
                graphics_clock_mhz: gfx_clock.unwrap_or(0),
                memory_clock_mhz: mem_clock.unwrap_or(0),
                // Clamp defensively: NVML's `utilization.gpu` is documented
                // as a 0-100 percentage, but glitchy drivers have been
                // observed to return transient out-of-range values. This is
                // a percentage and must never leave the client out of
                // range, regardless of what the driver hands back.
                utilization_pct: utilization.gpu.min(100),
                pcie_link_width_current: pcie_current,
                pcie_link_width_max: pcie_max,
            })
        }
    }

    /// Runs an NVML getter that writes a single `unsigned int`, returning
    /// `None` rather than an error when the driver says it isn't supported.
    unsafe fn read_optional_uint(&self, mut call: impl FnMut(*mut c_uint) -> i32) -> Option<u32> {
        let mut value: c_uint = 0;
        if call(&mut value) == NVML_SUCCESS {
            Some(value)
        } else {
            None
        }
    }

    unsafe fn read_string(
        &self,
        device: NvmlDevice,
        f: &Symbol<'static, unsafe extern "C" fn(NvmlDevice, *mut c_char, c_uint) -> i32>,
        buf_size: usize,
    ) -> anyhow::Result<String> {
        let mut buf = vec![0u8; buf_size];
        check(unsafe { f(device, buf.as_mut_ptr() as *mut c_char, buf_size as c_uint) })?;
        Ok(CStr::from_bytes_until_nul(&buf)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default())
    }
}

impl Drop for Nvml {
    fn drop(&mut self) {
        unsafe {
            let _ = (self.shutdown)();
        }
    }
}

fn check(rc: i32) -> anyhow::Result<()> {
    if rc == NVML_SUCCESS {
        Ok(())
    } else {
        anyhow::bail!("NVML call failed: {} (rc={rc})", nvml_error_name(rc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins `nvmlPciInfo_t`'s layout against nvml.h. These offsets are the
    /// difference between a correct hardware fingerprint and four bytes of
    /// ASCII bus-address text reinterpreted as an integer, and getting them
    /// wrong produces no error at runtime on any card — the previous version
    /// of this struct shipped with a 32-byte leading buffer where the header
    /// has 16, and nothing anywhere would have caught it.
    #[test]
    fn pci_info_matches_nvml_header_layout() {
        use std::mem::offset_of;
        assert_eq!(offset_of!(NvmlPciInfo, bus_id_legacy), 0);
        assert_eq!(offset_of!(NvmlPciInfo, domain), 16);
        assert_eq!(offset_of!(NvmlPciInfo, bus), 20);
        assert_eq!(offset_of!(NvmlPciInfo, device), 24);
        assert_eq!(offset_of!(NvmlPciInfo, pci_device_id), 28);
        assert_eq!(offset_of!(NvmlPciInfo, pci_sub_system_id), 32);
        assert_eq!(offset_of!(NvmlPciInfo, bus_id), 36);
        // Must be at least the 68 bytes nvml.h defines, so NVML can never
        // write past what was allocated.
        assert!(std::mem::size_of::<NvmlPciInfo>() >= 68);
    }

    #[test]
    fn memory_info_matches_nvml_header_layout() {
        use std::mem::offset_of;
        assert_eq!(offset_of!(NvmlMemoryInfo, total), 0);
        assert_eq!(offset_of!(NvmlMemoryInfo, free), 8);
        assert_eq!(offset_of!(NvmlMemoryInfo, used), 16);
    }

    /// pciDeviceId packs the device ID in the high half and the vendor ID in
    /// the low half. An RTX 4070 reports 0x278610DE.
    #[test]
    fn splits_packed_pci_id() {
        let packed: u32 = 0x2786_10DE;
        assert_eq!(packed >> 16, 0x2786);
        assert_eq!(packed & 0xFFFF, NVIDIA_VENDOR_ID);
    }
}
