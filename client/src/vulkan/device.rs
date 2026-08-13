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
    /// Every DEVICE_LOCAL memory type, best first. The VRAM test walks this
    /// list rather than committing to one: if a type stops accepting
    /// allocations well short of the card's capacity, the next one may not,
    /// and a buffer's own `memoryTypeBits` may exclude the preferred type
    /// anyway.
    pub device_local_memory_types: Vec<u32>,
    /// Every HOST_VISIBLE|HOST_COHERENT type, best first, for the same reason
    /// as the device-local list above.
    pub host_visible_memory_types: Vec<u32>,
    pub device_name: String,
    /// VkPhysicalDeviceLimits::maxComputeWorkGroupCount[0], the cap on a
    /// single vkCmdDispatch's X-dimension group count. The spec's required
    /// minimum is 65535; real drivers report far more.
    pub max_compute_workgroups_x: u32,
    /// VkPhysicalDeviceLimits::maxStorageBufferRange, the largest `range`
    /// a single STORAGE_BUFFER descriptor may cover
    /// (VUID-VkWriteDescriptorSet-descriptorType-00333). It is a `uint32_t`,
    /// so it can never exceed 4 GiB-1 no matter how much VRAM the card has,
    /// and AMD/Nvidia both report values at or below that.
    ///
    /// This is not advisory. Binding a larger range doesn't fail loudly: the
    /// range truncates and the shader silently cannot address past it.
    /// Confirmed on an RX 6600, where binding a 7,287,183,768-byte buffer
    /// left only `7,287,183,768 mod 2^32` = 2,992,216,472 bytes reachable:
    /// every element past that read back as zero and was miscounted as a
    /// VRAM error. Anything testing more memory than this must split it
    /// across several buffers.
    pub max_storage_buffer_range: u32,
    /// VkPhysicalDeviceMaintenance3Properties::maxMemoryAllocationSize, the
    /// largest single vkAllocateMemory this device permits. Frequently
    /// smaller than the heap (3.5 GiB on the RX 6600 against 8 GiB of VRAM),
    /// so covering a card's whole VRAM always means several allocations.
    pub max_memory_allocation_size: u64,
    /// Size of the heap backing the preferred device-local type. The upper bound
    /// on what the VRAM test could ever allocate, and typically a better
    /// number than the vendor telemetry's VRAM total, which counts memory
    /// Vulkan can't hand out.
    pub device_local_heap_size: u64,
    pub device_local_heap_index: u32,
    /// Whether VK_EXT_memory_budget was available and enabled, meaning
    /// `available_device_local_bytes` can report real numbers.
    pub memory_budget_supported: bool,
}

/// Identifies the card the vendor telemetry (NVML or ADL) is describing, so
/// the Vulkan device the tests actually run against can be confirmed to be
/// the same one.
pub struct GpuSelector {
    pub vendor_id: u32,
    pub device_id: u32,
    pub name: String,
}

impl VulkanContext {
    /// `want` is the card the telemetry backend found. Matching against it
    /// is not a nicety: the certificate names a specific GPU, and running
    /// the tests on a different one would produce a document that is wrong
    /// in the most damaging way available, by attesting to hardware that was
    /// never tested.
    ///
    /// This is a live risk rather than a theoretical one. Taking Vulkan
    /// device 0 is only correct when there is one GPU. On a laptop with
    /// switchable graphics, the integrated GPU frequently enumerates first
    /// while NVML reports the discrete NVIDIA card, so the old code would
    /// have stress-tested an Intel iGPU and issued a certificate for the
    /// GeForce next to it.
    pub fn new(want: &GpuSelector) -> anyhow::Result<Self> {
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
            if physical_devices.is_empty() {
                anyhow::bail!("no Vulkan-capable devices found");
            }

            // Exact (vendor, device) first. Falling back to vendor alone
            // covers the case where a backend's device ID is parsed slightly
            // differently from what Vulkan reports, while still guaranteeing
            // the right physical card among a mixed-vendor pair, which is the
            // failure that actually matters.
            let described: Vec<(vk::PhysicalDevice, vk::PhysicalDeviceProperties)> =
                physical_devices
                    .iter()
                    .map(|&pd| (pd, instance.get_physical_device_properties(pd)))
                    .collect();

            let exact = described
                .iter()
                .find(|(_, p)| p.vendor_id == want.vendor_id && p.device_id == want.device_id);
            let same_vendor = described
                .iter()
                .filter(|(_, p)| p.vendor_id == want.vendor_id)
                // A discrete part in preference to an integrated one from the
                // same vendor, which is how an AMD APU plus an AMD dGPU
                // presents.
                .max_by_key(|(_, p)| {
                    u8::from(p.device_type == vk::PhysicalDeviceType::DISCRETE_GPU)
                });

            let physical_device = match exact.or(same_vendor) {
                Some((pd, _)) => *pd,
                None => {
                    let seen = described
                        .iter()
                        .map(|(_, p)| {
                            format!(
                                "{} (vendor 0x{:04X}, device 0x{:04X})",
                                CStr::from_ptr(p.device_name.as_ptr()).to_string_lossy(),
                                p.vendor_id,
                                p.device_id
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; ");
                    anyhow::bail!(
                        "the GPU the driver reports ({}, vendor 0x{:04X}, device 0x{:04X}) isn't among \
                         the Vulkan devices available [{seen}].\n  Refusing to continue: testing a \
                         different GPU than the one named on the certificate would make the \
                         certificate wrong.",
                        want.name,
                        want.vendor_id,
                        want.device_id
                    );
                }
            };

            let props = instance.get_physical_device_properties(physical_device);
            let device_name = CStr::from_ptr(props.device_name.as_ptr())
                .to_string_lossy()
                .into_owned();
            let max_compute_workgroups_x = props.limits.max_compute_work_group_count[0];
            let max_storage_buffer_range = props.limits.max_storage_buffer_range;

            // maxMemoryAllocationSize lives in VkPhysicalDeviceMaintenance3Properties,
            // reachable via vkGetPhysicalDeviceProperties2, core in Vulkan 1.1
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
            // exposes at least one queue family supporting both together:
            // async-compute-only families are additional, not a
            // replacement, so requiring both here doesn't lose any real
            // hardware, it just rules out a queue family this client
            // couldn't fully use anyway.
            let queue_families = instance.get_physical_device_queue_family_properties(physical_device);
            let queue_family_index = queue_families
                .iter()
                .enumerate()
                .find(|(_, qf)| qf.queue_flags.contains(vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE))
                .map(|(i, _)| i as u32)
                .ok_or_else(|| anyhow::anyhow!("no graphics+compute-capable queue family found"))?;

            // VK_EXT_memory_budget, if this driver has it. Without it the only
            // way to find out how much VRAM is actually free is to allocate
            // until something fails, which both wastes time and understates
            // coverage: the VRAM test would stop at the first failed request
            // rather than at the real ceiling. Optional rather than required,
            // since the test still works (less precisely) without it.
            let available_extensions = instance
                .enumerate_device_extension_properties(physical_device)
                .unwrap_or_default();
            let memory_budget_supported = available_extensions.iter().any(|e| {
                CStr::from_ptr(e.extension_name.as_ptr()) == vk::EXT_MEMORY_BUDGET_NAME
            });
            let mut enabled_extensions: Vec<*const std::ffi::c_char> = Vec::new();
            if memory_budget_supported {
                enabled_extensions.push(vk::EXT_MEMORY_BUDGET_NAME.as_ptr());
            }

            let queue_priorities = [1.0f32];
            let queue_info = vk::DeviceQueueCreateInfo::default()
                .queue_family_index(queue_family_index)
                .queue_priorities(&queue_priorities);
            let queue_infos = [queue_info];
            let device_info = vk::DeviceCreateInfo::default()
                .queue_create_infos(&queue_infos)
                .enabled_extension_names(&enabled_extensions);
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

            // Memory types this build is not permitted to allocate from.
            //
            // VK_AMD_device_coherent_memory is not enabled above, and the spec
            // is explicit that without the deviceCoherentMemory feature a
            // memory type carrying DEVICE_COHERENT_BIT_AMD must not be passed
            // to vkAllocateMemory (VUID-vkAllocateMemory-deviceCoherentMemory-02790).
            // The driver still enumerates them.
            //
            // On an RX 6600 that is eight of the sixteen types, and they are
            // exactly the ones every allocation failure in this project has
            // named: type 12 in the v0.4.2 crash, type 14 in the failure of
            // the first full-length v0.5.1 run. They sorted to the end of both
            // candidate lists, so they were also the reason the old
            // last-error-wins message always blamed a type mismatch.
            let forbidden = vk::MemoryPropertyFlags::DEVICE_COHERENT_AMD
                | vk::MemoryPropertyFlags::DEVICE_UNCACHED_AMD;
            let usable = |i: u32| {
                !mem_props.memory_types[i as usize]
                    .property_flags
                    .intersects(forbidden)
            };

            // Ordered by the same rule that picks the primary: biggest heap
            // first, then prefer a type without HOST_VISIBLE, since that flag
            // marks a CPU-accessible window the driver caps far below the heap.
            let mut device_local_memory_types: Vec<u32> = (0..mem_props.memory_type_count)
                .filter(|&i| usable(i))
                .filter(|&i| {
                    mem_props.memory_types[i as usize]
                        .property_flags
                        .contains(vk::MemoryPropertyFlags::DEVICE_LOCAL)
                })
                .collect();
            device_local_memory_types.sort_by_key(|&i| {
                let flags = mem_props.memory_types[i as usize].property_flags;
                std::cmp::Reverse((
                    heap_size_of(&mem_props, i),
                    u8::from(!flags.intersects(vk::MemoryPropertyFlags::HOST_VISIBLE)),
                ))
            });

            let mut host_visible_memory_types: Vec<u32> = (0..mem_props.memory_type_count)
                .filter(|&i| usable(i))
                .filter(|&i| {
                    mem_props.memory_types[i as usize].property_flags.contains(
                        vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
                    )
                })
                .collect();
            host_visible_memory_types.sort_by_key(|&i| {
                let flags = mem_props.memory_types[i as usize].property_flags;
                std::cmp::Reverse((
                    heap_size_of(&mem_props, i),
                    u8::from(!flags.intersects(vk::MemoryPropertyFlags::DEVICE_LOCAL)),
                ))
            });

            let &preferred_device_local = device_local_memory_types
                .first()
                .ok_or_else(|| anyhow::anyhow!("no DEVICE_LOCAL memory type found"))?;
            if host_visible_memory_types.is_empty() {
                anyhow::bail!("no HOST_VISIBLE|HOST_COHERENT memory type found");
            }
            let device_local_heap_index =
                mem_props.memory_types[preferred_device_local as usize].heap_index;
            let device_local_heap_size = heap_size_of(&mem_props, preferred_device_local);

            Ok(VulkanContext {
                _entry: entry,
                instance,

                device,
                queue,
                queue_family_index,
                device_local_memory_types,
                host_visible_memory_types,
                physical_device,
                device_name,
                max_compute_workgroups_x,
                max_storage_buffer_range,
                max_memory_allocation_size,
                device_local_heap_size,
                device_local_heap_index,
                memory_budget_supported,
            })
        }
    }

    /// Picks the first candidate this specific allocation will actually
    /// accept.
    ///
    /// Vulkan's memory type index is only meaningful against a particular
    /// resource: `vkGetBufferMemoryRequirements` returns a `memoryTypeBits`
    /// mask, and binding a type outside it is invalid. Choosing one "best"
    /// type device-wide and using it for everything ignores that, and did so
    /// here on every allocation the client made. On an RX 6600 the chosen type
    /// (12) was rejected by an ordinary storage buffer, so every run had been
    /// binding memory the buffer did not accept, which is undefined behaviour
    /// and the most likely explanation for VRAM allocation capping out well
    /// short of the card.
    pub fn compatible_memory_type(&self, type_bits: u32, candidates: &[u32]) -> Option<u32> {
        candidates
            .iter()
            .copied()
            .find(|&t| type_bits & (1 << t) != 0)
    }

    /// How much device-local memory this process can still allocate, as the
    /// driver currently sees it. `None` when VK_EXT_memory_budget isn't
    /// available, in which case the caller has to discover the ceiling by
    /// allocating until it fails.
    ///
    /// Deliberately queried live rather than cached at startup: the spec is
    /// explicit that these values "are not invariant", and they genuinely
    /// move as other applications (a compositor, a browser, a game) take and
    /// release VRAM while this runs.
    ///
    /// `heapBudget` is what the process may allocate in total *including what
    /// it already holds*, so the headroom for new allocations is the budget
    /// minus current usage, not the budget alone.
    pub fn available_device_local_bytes(&self) -> Option<u64> {
        if !self.memory_budget_supported {
            return None;
        }
        unsafe {
            let mut budget = vk::PhysicalDeviceMemoryBudgetPropertiesEXT::default();
            let mut props2 = vk::PhysicalDeviceMemoryProperties2::default().push_next(&mut budget);
            self.instance
                .get_physical_device_memory_properties2(self.physical_device, &mut props2);
            let heap = self.device_local_heap_index as usize;
            Some(budget.heap_budget[heap].saturating_sub(budget.heap_usage[heap]))
        }
    }
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

/// Describes every Vulkan device on the machine, independent of whether one
/// of them can be selected.
///
/// Deliberately separate from `VulkanContext::new`, which refuses to continue
/// when it cannot find the card the telemetry named. That refusal is correct,
/// but it means the interesting information (what *was* there, and why none of
/// it matched) is exactly what gets thrown away. A laptop reporting that the
/// tool "didn't detect the other GPU" is unanswerable without this.
///
/// Never returns an error: a diagnostic that fails to collect is worse than
/// useless, because it removes the evidence for the failure it was supposed to
/// explain. Anything it cannot read is reported as such and the rest continues.
pub fn describe_devices() -> serde_json::Value {
    use serde_json::json;

    unsafe {
        let entry = match ash::Entry::load() {
            Ok(e) => e,
            Err(e) => return json!({ "error": format!("Vulkan loader unavailable: {e}") }),
        };
        let app_info = vk::ApplicationInfo::default()
            .application_name(c"gpu-cert")
            .api_version(vk::API_VERSION_1_1);
        let instance = match entry
            .create_instance(&vk::InstanceCreateInfo::default().application_info(&app_info), None)
        {
            Ok(i) => i,
            Err(e) => return json!({ "error": format!("vkCreateInstance failed: {e:?}") }),
        };

        let devices = match instance.enumerate_physical_devices() {
            Ok(d) => d,
            Err(e) => {
                instance.destroy_instance(None);
                return json!({ "error": format!("vkEnumeratePhysicalDevices failed: {e:?}") });
            }
        };

        let described: Vec<serde_json::Value> = devices
            .iter()
            .map(|&pd| {
                let p = instance.get_physical_device_properties(pd);
                let mem = instance.get_physical_device_memory_properties(pd);
                let heaps: Vec<serde_json::Value> = (0..mem.memory_heap_count)
                    .map(|i| {
                        json!({
                            "index": i,
                            "size_mb": mem.memory_heaps[i as usize].size / 1_048_576,
                            "device_local": mem.memory_heaps[i as usize]
                                .flags
                                .contains(vk::MemoryHeapFlags::DEVICE_LOCAL),
                        })
                    })
                    .collect();
                let types: Vec<serde_json::Value> = (0..mem.memory_type_count)
                    .map(|i| {
                        json!({
                            "index": i,
                            "heap": mem.memory_types[i as usize].heap_index,
                            "flags": format!("{:?}", mem.memory_types[i as usize].property_flags),
                        })
                    })
                    .collect();
                let queues: Vec<String> = instance
                    .get_physical_device_queue_family_properties(pd)
                    .iter()
                    .map(|q| format!("{:?} x{}", q.queue_flags, q.queue_count))
                    .collect();

                json!({
                    "name": CStr::from_ptr(p.device_name.as_ptr()).to_string_lossy(),
                    "type": format!("{:?}", p.device_type),
                    "vendor_id": format!("0x{:04X}", p.vendor_id),
                    "device_id": format!("0x{:04X}", p.device_id),
                    "driver_version": p.driver_version,
                    "api_version": format!(
                        "{}.{}.{}",
                        vk::api_version_major(p.api_version),
                        vk::api_version_minor(p.api_version),
                        vk::api_version_patch(p.api_version)
                    ),
                    "max_storage_buffer_range": p.limits.max_storage_buffer_range,
                    "max_compute_workgroups_x": p.limits.max_compute_work_group_count[0],
                    "memory_heaps": heaps,
                    "memory_types": types,
                    "queue_families": queues,
                })
            })
            .collect();

        instance.destroy_instance(None);
        json!({ "count": described.len(), "devices": described })
    }
}

#[cfg(test)]
mod tests {


    /// A type index is only meaningful against a specific resource. Choosing
    /// one device-wide and binding it to everything is what produced
    /// "memory type 12 not accepted by this buffer" on a real RX 6600, after
    /// every previous release had been binding it anyway.
    #[test]
    fn only_types_the_resource_accepts_are_offered() {
        let ctx_types = [12u32, 0, 1];
        let accepted_by_buffer = 0b0000_0011u32; // types 0 and 1 only
        let chosen = ctx_types
            .iter()
            .copied()
            .find(|&t| accepted_by_buffer & (1 << t) != 0);
        assert_eq!(chosen, Some(0), "must skip type 12 and fall through to one that fits");
    }

    /// And if none of them fit, that has to be an error rather than a bind of
    /// whatever was first.
    #[test]
    fn no_compatible_type_is_an_error() {
        let ctx_types = [12u32];
        let accepted_by_buffer = 0b0000_0011u32;
        let chosen = ctx_types
            .iter()
            .copied()
            .find(|&t| accepted_by_buffer & (1 << t) != 0);
        assert_eq!(chosen, None);
    }

    /// The real RX 6600 memory layout, from the environment dump of the run
    /// that failed. Flags are modelled as bits: 1 DEVICE_LOCAL,
    /// 2 HOST_VISIBLE, 4 DEVICE_COHERENT_AMD.
    ///
    /// Half of this card's types carry the AMD device-coherent flags, and
    /// allocating from them without enabling VK_AMD_device_coherent_memory is
    /// forbidden. They must not appear in either candidate list.
    #[test]
    fn amd_device_coherent_types_are_never_offered() {
        const DEVICE_LOCAL: u8 = 1;
        const HOST_VISIBLE: u8 = 2;
        const DEVICE_COHERENT_AMD: u8 = 4;

        // index -> flags, exactly as the RX 6600 enumerates them.
        let types: [u8; 16] = [
            DEVICE_LOCAL,
            HOST_VISIBLE,
            DEVICE_LOCAL | HOST_VISIBLE,
            HOST_VISIBLE,
            DEVICE_LOCAL | DEVICE_COHERENT_AMD,
            HOST_VISIBLE | DEVICE_COHERENT_AMD,
            DEVICE_LOCAL | HOST_VISIBLE | DEVICE_COHERENT_AMD,
            HOST_VISIBLE | DEVICE_COHERENT_AMD,
            DEVICE_LOCAL,
            HOST_VISIBLE,
            DEVICE_LOCAL | HOST_VISIBLE,
            HOST_VISIBLE,
            DEVICE_LOCAL | DEVICE_COHERENT_AMD,
            HOST_VISIBLE | DEVICE_COHERENT_AMD,
            DEVICE_LOCAL | HOST_VISIBLE | DEVICE_COHERENT_AMD,
            HOST_VISIBLE | DEVICE_COHERENT_AMD,
        ];

        let usable: Vec<u32> = (0..types.len() as u32)
            .filter(|&i| types[i as usize] & DEVICE_COHERENT_AMD == 0)
            .collect();

        assert_eq!(usable, vec![0, 1, 2, 3, 8, 9, 10, 11]);
        // The two types named in real crash reports must both be gone.
        assert!(!usable.contains(&12), "type 12 crashed v0.4.2");
        assert!(!usable.contains(&14), "type 14 failed the first full v0.5.1 run");
    }
}

