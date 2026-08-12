//! Shared plumbing for running a one-shot compute dispatch: shader module +
//! descriptor set layout (N storage buffers) + pipeline layout (one push
//! constant range) + pipeline, then a single command buffer that binds,
//! dispatches, and is submitted+waited synchronously. Both the stress
//! kernel and the VRAM pattern test are "dispatch, wait, read result back"
//! workloads, so they share this instead of duplicating the ~150 lines of
//! Vulkan boilerplate each dispatch needs.

use ash::vk;

use super::device::VulkanContext;

pub struct GpuBuffer {
    pub buffer: vk::Buffer,
    pub memory: vk::DeviceMemory,
    pub size: vk::DeviceSize,
}

impl GpuBuffer {
    pub fn new(
        ctx: &VulkanContext,
        size: vk::DeviceSize,
        usage: vk::BufferUsageFlags,
        memory_type: u32,
    ) -> anyhow::Result<Self> {
        unsafe {
            let buffer_info = vk::BufferCreateInfo::default()
                .size(size)
                .usage(usage)
                .sharing_mode(vk::SharingMode::EXCLUSIVE);
            let buffer = ctx
                .device
                .create_buffer(&buffer_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateBuffer failed: {e:?}"))?;

            let requirements = ctx.device.get_buffer_memory_requirements(buffer);
            let alloc_info = vk::MemoryAllocateInfo::default()
                .allocation_size(requirements.size)
                .memory_type_index(memory_type);
            let memory = ctx
                .device
                .allocate_memory(&alloc_info, None)
                .map_err(|e| anyhow::anyhow!("vkAllocateMemory failed: {e:?}"))?;

            ctx.device
                .bind_buffer_memory(buffer, memory, 0)
                .map_err(|e| anyhow::anyhow!("vkBindBufferMemory failed: {e:?}"))?;

            Ok(GpuBuffer { buffer, memory, size })
        }
    }

    pub fn destroy(&self, ctx: &VulkanContext) {
        unsafe {
            ctx.device.destroy_buffer(self.buffer, None);
            ctx.device.free_memory(self.memory, None);
        }
    }
}

pub struct ComputeKernel {
    shader_module: vk::ShaderModule,
    descriptor_set_layout: vk::DescriptorSetLayout,
    pipeline_layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    descriptor_pool: vk::DescriptorPool,
    command_pool: vk::CommandPool,
}

impl ComputeKernel {
    /// `buffer_count` = number of storage buffers the shader's descriptor
    /// set binds (1 for the stress kernel, 2 for VRAM pattern: data + error
    /// counter). `push_constant_size` in bytes.
    pub fn new(
        ctx: &VulkanContext,
        spirv: &[u8],
        buffer_count: u32,
        push_constant_size: u32,
    ) -> anyhow::Result<Self> {
        unsafe {
            let code = ash::util::read_spv(&mut std::io::Cursor::new(spirv))
                .map_err(|e| anyhow::anyhow!("invalid SPIR-V: {e}"))?;
            let shader_info = vk::ShaderModuleCreateInfo::default().code(&code);
            let shader_module = ctx
                .device
                .create_shader_module(&shader_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateShaderModule failed: {e:?}"))?;

            let bindings: Vec<vk::DescriptorSetLayoutBinding> = (0..buffer_count)
                .map(|i| {
                    vk::DescriptorSetLayoutBinding::default()
                        .binding(i)
                        .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
                        .descriptor_count(1)
                        .stage_flags(vk::ShaderStageFlags::COMPUTE)
                })
                .collect();
            let layout_info = vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings);
            let descriptor_set_layout = ctx
                .device
                .create_descriptor_set_layout(&layout_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateDescriptorSetLayout failed: {e:?}"))?;

            let set_layouts = [descriptor_set_layout];
            let push_constant_ranges = [vk::PushConstantRange::default()
                .stage_flags(vk::ShaderStageFlags::COMPUTE)
                .offset(0)
                .size(push_constant_size)];
            let pipeline_layout_info = vk::PipelineLayoutCreateInfo::default()
                .set_layouts(&set_layouts)
                .push_constant_ranges(&push_constant_ranges);
            let pipeline_layout = ctx
                .device
                .create_pipeline_layout(&pipeline_layout_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreatePipelineLayout failed: {e:?}"))?;

            let entry_point = c"main";
            let stage_info = vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::COMPUTE)
                .module(shader_module)
                .name(entry_point);
            let pipeline_info = vk::ComputePipelineCreateInfo::default()
                .stage(stage_info)
                .layout(pipeline_layout);
            let pipelines = ctx
                .device
                .create_compute_pipelines(vk::PipelineCache::null(), &[pipeline_info], None)
                .map_err(|(_, e)| anyhow::anyhow!("vkCreateComputePipelines failed: {e:?}"))?;
            let pipeline = pipelines[0];

            let pool_sizes = [vk::DescriptorPoolSize::default()
                .ty(vk::DescriptorType::STORAGE_BUFFER)
                .descriptor_count(buffer_count)];
            // FREE_DESCRIPTOR_SET is required for `dispatch`'s per-call
            // free_descriptor_sets to actually do anything — without it,
            // freeing is a spec-defined no-op (drivers vary on whether they
            // even error on the attempt), so with max_sets(1) the pool
            // silently permanently exhausts after exactly one dispatch:
            // confirmed on real hardware as ERROR_OUT_OF_POOL_MEMORY on the
            // second call, one tick into the stress test.
            let pool_info = vk::DescriptorPoolCreateInfo::default()
                .flags(vk::DescriptorPoolCreateFlags::FREE_DESCRIPTOR_SET)
                .pool_sizes(&pool_sizes)
                .max_sets(1);
            let descriptor_pool = ctx
                .device
                .create_descriptor_pool(&pool_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateDescriptorPool failed: {e:?}"))?;

            let command_pool_info =
                vk::CommandPoolCreateInfo::default().queue_family_index(ctx.queue_family_index);
            let command_pool = ctx
                .device
                .create_command_pool(&command_pool_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateCommandPool failed: {e:?}"))?;

            Ok(ComputeKernel {
                shader_module,
                descriptor_set_layout,
                pipeline_layout,
                pipeline,
                descriptor_pool,
                command_pool,
            })
        }
    }

    /// Binds `buffers` to sequential descriptor bindings, dispatches
    /// `workgroups` groups with `push_constants` bytes pushed, and blocks
    /// until the GPU finishes. One-shot by design — stress test duration is
    /// controlled by looping `dispatch` calls, not by a single long dispatch,
    /// so it can be interrupted between iterations.
    pub fn dispatch(
        &self,
        ctx: &VulkanContext,
        buffers: &[&GpuBuffer],
        push_constants: &[u8],
        workgroups: u32,
    ) -> anyhow::Result<()> {
        unsafe {
            let set_layouts = [self.descriptor_set_layout];
            let alloc_info = vk::DescriptorSetAllocateInfo::default()
                .descriptor_pool(self.descriptor_pool)
                .set_layouts(&set_layouts);
            let descriptor_sets = ctx
                .device
                .allocate_descriptor_sets(&alloc_info)
                .map_err(|e| anyhow::anyhow!("vkAllocateDescriptorSets failed: {e:?}"))?;
            let descriptor_set = descriptor_sets[0];

            let buffer_infos: Vec<vk::DescriptorBufferInfo> = buffers
                .iter()
                .map(|b| {
                    vk::DescriptorBufferInfo::default()
                        .buffer(b.buffer)
                        .offset(0)
                        .range(b.size)
                })
                .collect();
            let writes: Vec<vk::WriteDescriptorSet> = buffer_infos
                .iter()
                .enumerate()
                .map(|(i, info)| {
                    vk::WriteDescriptorSet::default()
                        .dst_set(descriptor_set)
                        .dst_binding(i as u32)
                        .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
                        .buffer_info(std::slice::from_ref(info))
                })
                .collect();
            ctx.device.update_descriptor_sets(&writes, &[]);

            let cmd_alloc_info = vk::CommandBufferAllocateInfo::default()
                .command_pool(self.command_pool)
                .level(vk::CommandBufferLevel::PRIMARY)
                .command_buffer_count(1);
            let cmd_buffers = ctx
                .device
                .allocate_command_buffers(&cmd_alloc_info)
                .map_err(|e| anyhow::anyhow!("vkAllocateCommandBuffers failed: {e:?}"))?;
            let cmd = cmd_buffers[0];

            let begin_info = vk::CommandBufferBeginInfo::default()
                .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT);
            ctx.device
                .begin_command_buffer(cmd, &begin_info)
                .map_err(|e| anyhow::anyhow!("vkBeginCommandBuffer failed: {e:?}"))?;
            ctx.device
                .cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.pipeline);
            ctx.device.cmd_bind_descriptor_sets(
                cmd,
                vk::PipelineBindPoint::COMPUTE,
                self.pipeline_layout,
                0,
                &[descriptor_set],
                &[],
            );
            if !push_constants.is_empty() {
                ctx.device.cmd_push_constants(
                    cmd,
                    self.pipeline_layout,
                    vk::ShaderStageFlags::COMPUTE,
                    0,
                    push_constants,
                );
            }
            ctx.device.cmd_dispatch(cmd, workgroups, 1, 1);
            ctx.device
                .end_command_buffer(cmd)
                .map_err(|e| anyhow::anyhow!("vkEndCommandBuffer failed: {e:?}"))?;

            let fence_info = vk::FenceCreateInfo::default();
            let fence = ctx
                .device
                .create_fence(&fence_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateFence failed: {e:?}"))?;

            let cmd_buffers_submit = [cmd];
            let submit_info = vk::SubmitInfo::default().command_buffers(&cmd_buffers_submit);
            ctx.device
                .queue_submit(ctx.queue, &[submit_info], fence)
                .map_err(|e| anyhow::anyhow!("vkQueueSubmit failed: {e:?}"))?;
            ctx.device
                .wait_for_fences(&[fence], true, u64::MAX)
                .map_err(|e| anyhow::anyhow!("vkWaitForFences failed: {e:?}"))?;

            ctx.device.destroy_fence(fence, None);
            ctx.device.free_command_buffers(self.command_pool, &[cmd]);
            // Not `.ok()`-swallowed: a failure here means the next dispatch
            // will exhaust the pool, so surfacing it now is far more useful
            // than a confusing ERROR_OUT_OF_POOL_MEMORY on a later call.
            ctx.device
                .free_descriptor_sets(self.descriptor_pool, &[descriptor_set])
                .map_err(|e| anyhow::anyhow!("vkFreeDescriptorSets failed: {e:?}"))?;

            Ok(())
        }
    }
}

impl Drop for ComputeKernel {
    fn drop(&mut self) {
        // SAFETY: caller-provided VulkanContext must outlive this kernel;
        // enforced by construction (ComputeKernel::new borrows &VulkanContext,
        // and callers hold ctx for the kernel's whole lifetime).
        // Cleanup happens via explicit `destroy(ctx)` since Drop can't take
        // the context it needs — see call sites in stress.rs / vram_test.rs.
    }
}

impl ComputeKernel {
    pub fn destroy(&self, ctx: &VulkanContext) {
        unsafe {
            ctx.device.destroy_command_pool(self.command_pool, None);
            ctx.device.destroy_descriptor_pool(self.descriptor_pool, None);
            ctx.device.destroy_pipeline(self.pipeline, None);
            ctx.device.destroy_pipeline_layout(self.pipeline_layout, None);
            ctx.device
                .destroy_descriptor_set_layout(self.descriptor_set_layout, None);
            ctx.device.destroy_shader_module(self.shader_module, None);
        }
    }
}
