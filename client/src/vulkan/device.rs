use ash::vk;
use std::ffi::CStr;

/// Holds everything the stress/VRAM-test modules need: a compute-capable
/// queue and the memory type indices for device-local (VRAM) and
/// host-visible (staging/readback) allocations.
pub struct VulkanContext {
    _entry: ash::Entry,
    pub instance: ash::Instance,
    pub physical_device: vk::PhysicalDevice,
    pub device: ash::Device,
    pub queue: vk::Queue,
    pub queue_family_index: u32,
    pub device_local_memory_type: u32,
    pub host_visible_memory_type: u32,
    pub device_name: String,
    /// VkPhysicalDeviceLimits::maxComputeWorkGroupCount[0] — the real cap on
    /// a single vkCmdDispatch's X-dimension group count. Confirmed on real
    /// hardware (an RX 6600) that exceeding this doesn't produce a
    /// validation error or a clean clamp: the driver silently executes
    /// something other than the requested count (observed: dispatching
    /// ~7.1M groups when the real limit was ~4.2M corrupted results, not
    /// just truncated them safely). Large single-dispatch compute kernels
    /// must chunk against this rather than assume it's unbounded.
    pub max_compute_workgroups_x: u32,
}

impl VulkanContext {
    pub fn new() -> anyhow::Result<Self> {
        unsafe {
            let entry = ash::Entry::load()
                .map_err(|e| anyhow::anyhow!("failed to load Vulkan loader: {e}"))?;

            let app_info = vk::ApplicationInfo::default()
                .application_name(c"gpu-cert")
                .api_version(vk::API_VERSION_1_1);
            let instance_info = vk::InstanceCreateInfo::default().application_info(&app_info);
            let instance = entry
                .create_instance(&instance_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateInstance failed: {e:?}"))?;

            let physical_devices = instance
                .enumerate_physical_devices()
                .map_err(|e| anyhow::anyhow!("vkEnumeratePhysicalDevices failed: {e:?}"))?;
            // Phase 1 certifies whatever GPU is primary/index 0. Letting the
            // user pick among multiple GPUs is a product decision, deferred
            // alongside the same question in nvml.rs.
            let physical_device = *physical_devices
                .first()
                .ok_or_else(|| anyhow::anyhow!("no Vulkan-capable devices found"))?;

            let props = instance.get_physical_device_properties(physical_device);
            let device_name = CStr::from_ptr(props.device_name.as_ptr())
                .to_string_lossy()
                .into_owned();
            let max_compute_workgroups_x = props.limits.max_compute_work_group_count[0];

            // GRAPHICS, not just COMPUTE: the fur render test (graphics
            // pipeline correctness/display-output check) needs a
            // graphics-capable queue too. Every consumer Nvidia/AMD GPU
            // exposes at least one queue family supporting both together —
            // async-compute-only families are additional, not a
            // replacement — so requiring both here doesn't lose any real
            // hardware, it just rules out a queue family this client
            // couldn't fully use anyway.
            let queue_families = instance.get_physical_device_queue_family_properties(physical_device);
            let queue_family_index = queue_families
                .iter()
                .enumerate()
                .find(|(_, qf)| qf.queue_flags.contains(vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE))
                .map(|(i, _)| i as u32)
                .ok_or_else(|| anyhow::anyhow!("no graphics+compute-capable queue family found"))?;

            let queue_priorities = [1.0f32];
            let queue_info = vk::DeviceQueueCreateInfo::default()
                .queue_family_index(queue_family_index)
                .queue_priorities(&queue_priorities);
            let queue_infos = [queue_info];
            let device_info = vk::DeviceCreateInfo::default().queue_create_infos(&queue_infos);
            let device = instance
                .create_device(physical_device, &device_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateDevice failed: {e:?}"))?;

            let queue = device.get_device_queue(queue_family_index, 0);

            let mem_props = instance.get_physical_device_memory_properties(physical_device);
            let device_local_memory_type =
                find_memory_type(&mem_props, vk::MemoryPropertyFlags::DEVICE_LOCAL)
                    .ok_or_else(|| anyhow::anyhow!("no DEVICE_LOCAL memory type found"))?;
            let host_visible_memory_type = find_memory_type(
                &mem_props,
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
            )
            .ok_or_else(|| anyhow::anyhow!("no HOST_VISIBLE|HOST_COHERENT memory type found"))?;

            Ok(VulkanContext {
                _entry: entry,
                instance,
                physical_device,
                device,
                queue,
                queue_family_index,
                device_local_memory_type,
                host_visible_memory_type,
                device_name,
                max_compute_workgroups_x,
            })
        }
    }
}

fn find_memory_type(
    mem_props: &vk::PhysicalDeviceMemoryProperties,
    required: vk::MemoryPropertyFlags,
) -> Option<u32> {
    (0..mem_props.memory_type_count).find(|&i| {
        mem_props.memory_types[i as usize]
            .property_flags
            .contains(required)
    })
}

impl Drop for VulkanContext {
    fn drop(&mut self) {
        unsafe {
            self.device.destroy_device(None);
            self.instance.destroy_instance(None);
        }
    }
}
