//! AMD Display Library (ADL) bindings — the legacy C-ABI API, chosen over
//! ADLX for Phase 1 specifically to avoid writing a C++ shim just to get a
//! callable FFI surface from Rust (see the board's stack decision doc).
//! Windows-only: ADL ships as atiadlxx.dll (64-bit) / atiadlxy.dll (32-bit)
//! alongside the AMD driver.
//!
//! Not wired into `main.rs` yet — Nvidia dominates r/hardwareswap and OLX
//! listing volume, so AMD support is scaffolded but not Phase-1-blocking.
//! ADL requires the caller to supply a memory-allocation callback
//! (`ADL_Main_Memory_Alloc`) that ADL_Main_Control_Create invokes
//! internally; ATTACH_ONLY below wires that up but every telemetry field
//! read is still a `todo!()` pending real AMD hardware to validate against.

#![cfg(target_os = "windows")]

use libloading::{Library, Symbol};
use std::os::raw::{c_int, c_void};

const ADL_LIB_NAME: &str = "atiadlxx.dll";

extern "C" fn adl_main_memory_alloc(size: c_int) -> *mut c_void {
    unsafe { libc_alloc(size as usize) }
}

// Minimal malloc shim so we don't need to pull in the `libc` crate for one
// allocation callback ADL requires but never calls at high frequency.
unsafe fn libc_alloc(size: usize) -> *mut c_void {
    let layout = std::alloc::Layout::from_size_align(size, 16).unwrap();
    std::alloc::alloc(layout) as *mut c_void
}

type MainControlCreateFn = unsafe extern "C" fn(extern "C" fn(c_int) -> *mut c_void, c_int) -> c_int;
type MainControlDestroyFn = unsafe extern "C" fn() -> c_int;

pub struct Adl {
    _lib: Library,
    main_control_destroy: Symbol<'static, MainControlDestroyFn>,
}

impl Adl {
    pub fn load() -> anyhow::Result<Self> {
        unsafe {
            let lib = Library::new(ADL_LIB_NAME)
                .map_err(|e| anyhow::anyhow!("failed to load {ADL_LIB_NAME}: {e}"))?;

            let main_control_create: Symbol<'_, MainControlCreateFn> = lib
                .get(b"ADL_Main_Control_Create\0")
                .map_err(|e| anyhow::anyhow!("missing ADL symbol ADL_Main_Control_Create: {e}"))?;
            let main_control_destroy: Symbol<'_, MainControlDestroyFn> = lib
                .get(b"ADL_Main_Control_Destroy\0")
                .map_err(|e| anyhow::anyhow!("missing ADL symbol ADL_Main_Control_Destroy: {e}"))?;

            // 1 = ADL_TRUE (single-adapter context)
            let rc = main_control_create(adl_main_memory_alloc, 1);
            if rc != 0 {
                anyhow::bail!("ADL_Main_Control_Create failed: rc={rc}");
            }

            let main_control_destroy: Symbol<'static, MainControlDestroyFn> =
                std::mem::transmute(main_control_destroy);

            Ok(Adl {
                _lib: lib,
                main_control_destroy,
            })
        }
    }

    /// TODO: port ADL_Adapter_AdapterInfo_Get (identity), ADL_Overdrive6/N-series
    /// temperature/power/clock calls, and ADL2_Adapter_MemoryInfo2_Get (VRAM
    /// size + bus type) once there's real AMD listing volume to justify it
    /// (see stack decision doc — this is intentionally deferred past Phase 1).
    pub fn read_primary_gpu(&self) -> anyhow::Result<crate::nvml::GpuTelemetry> {
        todo!("AMD telemetry deferred past Phase 1 — see module docs")
    }
}

impl Drop for Adl {
    fn drop(&mut self) {
        unsafe {
            let _ = (self.main_control_destroy)();
        }
    }
}
