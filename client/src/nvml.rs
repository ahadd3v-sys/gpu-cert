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

type NvmlDevice = *mut c_void;

#[repr(C)]
struct NvmlPciInfo {
    bus_id: [c_char; 32],
    domain: c_uint,
    bus: c_uint,
    device: c_uint,
    pci_device_id: c_uint,
    pci_sub_system_id: c_uint,
    // trailing legacy fields omitted; NVML only reads bus_id..pci_device_id
    // for our purposes and the struct is over-allocated defensively below.
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
    pub pci_device_id: u32,
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

            let uuid = self.read_string(device, &self.device_get_uuid, NVML_DEVICE_UUID_BUFFER_SIZE)?;
            let name = self.read_string(device, &self.device_get_name, 96)?;

            let mut pci = NvmlPciInfo {
                bus_id: [0; 32],
                domain: 0,
                bus: 0,
                device: 0,
                pci_device_id: 0,
                pci_sub_system_id: 0,
                _reserved: [0; 64],
            };
            check((self.device_get_pci_info)(device, &mut pci))?;

            let mut mem = NvmlMemoryInfo { total: 0, free: 0, used: 0 };
            check((self.device_get_memory_info)(device, &mut mem))?;

            let mut temp: c_uint = 0;
            check((self.device_get_temperature)(device, NVML_TEMPERATURE_GPU, &mut temp))?;

            let mut power: c_uint = 0;
            check((self.device_get_power_usage)(device, &mut power))?;

            let mut gfx_clock: c_uint = 0;
            check((self.device_get_clock_info)(device, NVML_CLOCK_GRAPHICS, &mut gfx_clock))?;

            let mut mem_clock: c_uint = 0;
            check((self.device_get_clock_info)(device, NVML_CLOCK_MEM, &mut mem_clock))?;

            let mut utilization = NvmlUtilization { gpu: 0, memory: 0 };
            check((self.device_get_utilization_rates)(device, &mut utilization))?;

            let vbios_version =
                self.read_string(device, &self.device_get_vbios, NVML_DEVICE_VBIOS_VERSION_BUFFER_SIZE)?;

            let mut pcie_current: c_uint = 0;
            check((self.device_get_curr_pcie_link_width)(device, &mut pcie_current))?;

            let mut pcie_max: c_uint = 0;
            check((self.device_get_max_pcie_link_width)(device, &mut pcie_max))?;

            Ok(GpuTelemetry {
                uuid,
                name,
                pci_device_id: pci.pci_device_id,
                vbios_version,
                vram_total_bytes: mem.total,
                temperature_c: temp,
                power_draw_mw: power,
                graphics_clock_mhz: gfx_clock,
                memory_clock_mhz: mem_clock,
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
        anyhow::bail!("NVML call failed: rc={rc}")
    }
}
