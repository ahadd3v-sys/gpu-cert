use ash::vk;
use std::ffi::CStr;

/// Holds everything the stress/VRAM-test modules need: a compute-capable
/// queue and the memory type indices for device-local (VRAM) and
/// host-visible (staging/readback) allocations.
pub struct VulkanContext {
    _entry: ash::Entry,
    pub instance: ash::Instance,
    pub device: ash::Device,
    pub queue: vk::Queue,
    pub queue_family_index: u32,
    pub device_local_memory_type: u32,
    pub host_visible_memory_type: u32,
    pub device_name: String,
    /// VkPhysicalDeviceLimits::maxComputeWorkGroupCount[0] — the cap on a
    /// single vkCmdDispatch's X-dimension group count. The spec's required
    /// minimum is 65535; real drivers report far more.
    pub max_compute_workgroups_x: u32,
    /// VkPhysicalDeviceLimits::maxStorageBufferRange — the largest `range`
    /// a single STORAGE_BUFFER descriptor may cover
    /// (VUID-VkWriteDescriptorSet-descriptorType-00333). It is a `uint32_t`,
    /// so it can never exceed 4 GiB-1 no matter how much VRAM the card has,
    /// and AMD/Nvidia both report values at or below that.
    ///
    /// This is not advisory. Binding a larger range doesn't fail loudly: the
    /// range truncates and the shader silently cannot address past it.
    /// Confirmed on an RX 6600, where binding a 7,287,183,768-byte buffer
    /// left only `7,287,183,768 mod 2^32` = 2,992,216,472 bytes reachable —
    /// every element past that read back as zero and was miscounted as a
    /// VRAM error. Anything testing more memory than this must split it
    /// across several buffers.
    pub max_storage_buffer_range: u32,
    /// VkPhysicalDeviceMaintenance3Properties::maxMemoryAllocationSize — the
    /// largest single vkAllocateMemory this device permits. Frequently
    /// smaller than the heap (3.5 GiB on the RX 6600 against 8 GiB of VRAM),
    /// so covering a card's whole VRAM always means several allocations.
    pub max_memory_allocation_size: u64,
    /// Size of the heap backing `device_local_memory_type`. The upper bound
    /// on what the VRAM test could ever allocate, and typically a better
    /// number than the vendor telemetry's VRAM total, which counts memory
    /// Vulkan can't hand out.
    pub device_local_heap_size: u64,
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
            let max_storage_buffer_range = props.limits.max_storage_buffer_range;

            // maxMemoryAllocationSize lives in VkPhysicalDeviceMaintenance3Properties,
            // reachable via vkGetPhysicalDeviceProperties2 — core in Vulkan 1.1
            // but *not* in 1.0, and calling it against a 1.0 device is invalid.
            // Every GPU this client targets is 1.1+, so the fallback below is
            // belt-and-braces rather than a path expected to run: 256 MiB is
            // the spec's required minimum for maxStorageBufferRange, which
            // makes it a safe floor to assume when nothing better is known.
            const CONSERVATIVE_MAX_ALLOCATION: u64 = 256 * 1024 * 1024;
            let max_memory_allocation_size = if vk::api_version_major(props.api_version) >= 1
                && vk::api_version_minor(props.api_version) >= 1
            {
                let mut maintenance3 = vk::PhysicalDeviceMaintenance3Properties::default();
                let mut props2 =
                    vk::PhysicalDeviceProperties2::default().push_next(&mut maintenance3);
                instance.get_physical_device_properties2(physical_device, &mut props2);
                maintenance3.max_memory_allocation_size
            } else {
                CONSERVATIVE_MAX_ALLOCATION
            };

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
            // Largest heap, not merely the first match: AMD cards expose a
            // small (typically 256 MiB) DEVICE_LOCAL|HOST_VISIBLE type for the
            // PCIe BAR window alongside the real VRAM heap, and on some driver
            // versions it enumerates first. Taking the first DEVICE_LOCAL type
            // would then cap the VRAM test at the BAR size and silently test a
            // fraction of the card.
            let device_local_memory_type =
                find_largest_heap_memory_type(&mem_props, vk::MemoryPropertyFlags::DEVICE_LOCAL)
                    .ok_or_else(|| anyhow::anyhow!("no DEVICE_LOCAL memory type found"))?;
            let host_visible_memory_type = find_largest_heap_memory_type(
                &mem_props,
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
            )
            .ok_or_else(|| anyhow::anyhow!("no HOST_VISIBLE|HOST_COHERENT memory type found"))?;
            let device_local_heap_size = heap_size_of(&mem_props, device_local_memory_type);

            Ok(VulkanContext {
                _entry: entry,
                instance,

                device,
                queue,
                queue_family_index,
                device_local_memory_type,
                host_visible_memory_type,
                device_name,
                max_compute_workgroups_x,
                max_storage_buffer_range,
                max_memory_allocation_size,
                device_local_heap_size,
            })
        }
    }
}

fn find_largest_heap_memory_type(
    mem_props: &vk::PhysicalDeviceMemoryProperties,
    required: vk::MemoryPropertyFlags,
) -> Option<u32> {
    (0..mem_props.memory_type_count)
        .filter(|&i| {
            mem_props.memory_types[i as usize]
                .property_flags
                .contains(required)
        })
        .max_by_key(|&i| heap_size_of(mem_props, i))
}

fn heap_size_of(mem_props: &vk::PhysicalDeviceMemoryProperties, memory_type: u32) -> u64 {
    let heap_index = mem_props.memory_types[memory_type as usize].heap_index;
    mem_props.memory_heaps[heap_index as usize].size
}

impl Drop for VulkanContext {
    fn drop(&mut self) {
        unsafe {
            self.device.destroy_device(None);
            self.instance.destroy_instance(None);
        }
    }
}
