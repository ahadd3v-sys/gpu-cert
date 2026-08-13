//! Vulkan compute context via `ash`, raw bindings, not `wgpu`, so the VRAM
//! pattern test and stress kernels get the same buffer-level control
//! `memtest_vulkan` (our reference implementation) uses. This gives one
//! cross-vendor code path for both Nvidia and AMD load/VRAM testing,
//! independent of the vendor-specific NVML/ADL telemetry modules.

pub mod compute;
pub mod device;
pub mod fur_test;
pub mod stress;
pub mod vram_test;

pub use device::{describe_devices, GpuSelector, VulkanContext};

pub(crate) const STRESS_COMP_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/stress.comp.spv"));
pub(crate) const VRAM_PATTERN_COMP_SPV: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/vram_pattern.comp.spv"));
pub(crate) const FUR_VERT_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/fur.vert.spv"));
pub(crate) const FUR_FRAG_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/fur.frag.spv"));
