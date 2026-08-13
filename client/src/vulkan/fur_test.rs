//! Graphics-pipeline correctness + display-output test. The compute stress
//! kernel (stress.rs) generates thermal/power load but never checks its own
//! output, and runs pure compute, never touching the rasterizer/ROP/texture
//! path a real display pipeline uses — so neither silent ALU corruption nor
//! rasterizer-path corruption would be caught by it. This test renders
//! `fur.frag` (a fullscreen fragment shader, conceptually like FurMark's
//! "fur" load: heavy per-pixel ALU work through the real graphics pipeline)
//! and checks it: the shader is a pure deterministic function of (pixel
//! coordinate, iteration count, time), so the expected output at any pixel
//! can be recomputed on the CPU and compared against what the GPU actually
//! rendered. A mismatch beyond normal floating-point tolerance means the
//! GPU computed the wrong answer under load — a class of defect neither the
//! compute stress test nor the VRAM test can see.

use ash::vk;
use std::time::{Duration, Instant};

use super::device::VulkanContext;
use super::{FUR_FRAG_SPV, FUR_VERT_SPV};

const COLOR_WIDTH: u32 = 256;
const COLOR_HEIGHT: u32 = 256;
const COLOR_FORMAT: vk::Format = vk::Format::R8G8B8A8_UNORM;
// R8G8B8A8_UNORM color-attachment support is part of Vulkan's mandatory
// format support, unlike floating-point attachment formats — this needs to
// run correctly on whatever GPU a reseller happens to have, not just
// high-end ones, so portability wins over the extra precision an SFLOAT
// attachment would give.
const FUR_ITERATIONS: u32 = 4000;
// 8x8 grid spread across the image: enough spatial coverage to catch a
// localized ROP/texture-unit defect without re-deriving the shader's math
// (sin/cos per sample) for all 65536 pixels every frame.
const SAMPLE_GRID: u32 = 8;
// Real defects produce many wrong pixels, not one borderline pixel near a
// legitimate floating-point/quantization edge — this tolerates a small
// number of edge-case mismatches without being blind to systematic
// corruption, which blows past this by orders of magnitude.
const MISMATCH_EPSILON: f32 = 0.02;

pub struct FurTestResult {
    pub frames_rendered: u32,
    pub duration: Duration,
    pub mismatches: u32,
    pub pixels_checked: u32,
    pub aborted_for_safety: bool,
}

#[repr(C)]
struct PushConstants {
    iterations: u32,
    time: f32,
}

struct FurPipeline {
    vert_module: vk::ShaderModule,
    frag_module: vk::ShaderModule,
    render_pass: vk::RenderPass,
    pipeline_layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    color_image: vk::Image,
    color_memory: vk::DeviceMemory,
    color_view: vk::ImageView,
    framebuffer: vk::Framebuffer,
    readback_buffer: vk::Buffer,
    readback_memory: vk::DeviceMemory,
    command_pool: vk::CommandPool,
}

impl FurPipeline {
    fn new(ctx: &VulkanContext) -> anyhow::Result<Self> {
        unsafe {
            let vert_code = ash::util::read_spv(&mut std::io::Cursor::new(FUR_VERT_SPV))
                .map_err(|e| anyhow::anyhow!("invalid vertex SPIR-V: {e}"))?;
            let vert_module = ctx
                .device
                .create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&vert_code), None)
                .map_err(|e| anyhow::anyhow!("vkCreateShaderModule (vert) failed: {e:?}"))?;

            let frag_code = ash::util::read_spv(&mut std::io::Cursor::new(FUR_FRAG_SPV))
                .map_err(|e| anyhow::anyhow!("invalid fragment SPIR-V: {e}"))?;
            let frag_module = ctx
                .device
                .create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&frag_code), None)
                .map_err(|e| anyhow::anyhow!("vkCreateShaderModule (frag) failed: {e:?}"))?;

            let color_attachment = vk::AttachmentDescription::default()
                .format(COLOR_FORMAT)
                .samples(vk::SampleCountFlags::TYPE_1)
                .load_op(vk::AttachmentLoadOp::CLEAR)
                .store_op(vk::AttachmentStoreOp::STORE)
                .stencil_load_op(vk::AttachmentLoadOp::DONT_CARE)
                .stencil_store_op(vk::AttachmentStoreOp::DONT_CARE)
                .initial_layout(vk::ImageLayout::UNDEFINED)
                .final_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL);
            let color_attachment_ref = vk::AttachmentReference::default()
                .attachment(0)
                .layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL);
            let color_refs = [color_attachment_ref];
            let subpass = vk::SubpassDescription::default()
                .pipeline_bind_point(vk::PipelineBindPoint::GRAPHICS)
                .color_attachments(&color_refs);
            // The render pass writes the color attachment; the very next
            // command in the same command buffer reads it via a transfer
            // copy. Without this explicit dependency, nothing guarantees
            // the copy waits for the color write to finish — a well-known
            // Vulkan hazard, the default implicit external dependency isn't
            // sufficient here.
            let dependency = vk::SubpassDependency::default()
                .src_subpass(0)
                .dst_subpass(vk::SUBPASS_EXTERNAL)
                .src_stage_mask(vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT)
                .src_access_mask(vk::AccessFlags::COLOR_ATTACHMENT_WRITE)
                .dst_stage_mask(vk::PipelineStageFlags::TRANSFER)
                .dst_access_mask(vk::AccessFlags::TRANSFER_READ);
            let attachments = [color_attachment];
            let subpasses = [subpass];
            let dependencies = [dependency];
            let render_pass_info = vk::RenderPassCreateInfo::default()
                .attachments(&attachments)
                .subpasses(&subpasses)
                .dependencies(&dependencies);
            let render_pass = ctx
                .device
                .create_render_pass(&render_pass_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateRenderPass failed: {e:?}"))?;

            let push_constant_ranges = [vk::PushConstantRange::default()
                .stage_flags(vk::ShaderStageFlags::FRAGMENT)
                .offset(0)
                .size(std::mem::size_of::<PushConstants>() as u32)];
            let pipeline_layout_info =
                vk::PipelineLayoutCreateInfo::default().push_constant_ranges(&push_constant_ranges);
            let pipeline_layout = ctx
                .device
                .create_pipeline_layout(&pipeline_layout_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreatePipelineLayout failed: {e:?}"))?;

            let entry_point = c"main";
            let stages = [
                vk::PipelineShaderStageCreateInfo::default()
                    .stage(vk::ShaderStageFlags::VERTEX)
                    .module(vert_module)
                    .name(entry_point),
                vk::PipelineShaderStageCreateInfo::default()
                    .stage(vk::ShaderStageFlags::FRAGMENT)
                    .module(frag_module)
                    .name(entry_point),
            ];
            // No vertex buffers — fur.vert hardcodes a fullscreen triangle
            // from gl_VertexIndex.
            let vertex_input = vk::PipelineVertexInputStateCreateInfo::default();
            let input_assembly = vk::PipelineInputAssemblyStateCreateInfo::default()
                .topology(vk::PrimitiveTopology::TRIANGLE_LIST);
            let viewport = vk::Viewport {
                x: 0.0,
                y: 0.0,
                width: COLOR_WIDTH as f32,
                height: COLOR_HEIGHT as f32,
                min_depth: 0.0,
                max_depth: 1.0,
            };
            let scissor = vk::Rect2D {
                offset: vk::Offset2D { x: 0, y: 0 },
                extent: vk::Extent2D { width: COLOR_WIDTH, height: COLOR_HEIGHT },
            };
            let viewports = [viewport];
            let scissors = [scissor];
            let viewport_state = vk::PipelineViewportStateCreateInfo::default()
                .viewports(&viewports)
                .scissors(&scissors);
            let rasterization = vk::PipelineRasterizationStateCreateInfo::default()
                .polygon_mode(vk::PolygonMode::FILL)
                .cull_mode(vk::CullModeFlags::NONE)
                .front_face(vk::FrontFace::COUNTER_CLOCKWISE)
                .line_width(1.0);
            let multisample = vk::PipelineMultisampleStateCreateInfo::default()
                .rasterization_samples(vk::SampleCountFlags::TYPE_1);
            let blend_attachment = vk::PipelineColorBlendAttachmentState::default()
                .color_write_mask(vk::ColorComponentFlags::RGBA);
            let blend_attachments = [blend_attachment];
            let color_blend =
                vk::PipelineColorBlendStateCreateInfo::default().attachments(&blend_attachments);

            let pipeline_info = vk::GraphicsPipelineCreateInfo::default()
                .stages(&stages)
                .vertex_input_state(&vertex_input)
                .input_assembly_state(&input_assembly)
                .viewport_state(&viewport_state)
                .rasterization_state(&rasterization)
                .multisample_state(&multisample)
                .color_blend_state(&color_blend)
                .layout(pipeline_layout)
                .render_pass(render_pass)
                .subpass(0);
            let pipelines = ctx
                .device
                .create_graphics_pipelines(vk::PipelineCache::null(), &[pipeline_info], None)
                .map_err(|(_, e)| anyhow::anyhow!("vkCreateGraphicsPipelines failed: {e:?}"))?;
            let pipeline = pipelines[0];

            let image_info = vk::ImageCreateInfo::default()
                .image_type(vk::ImageType::TYPE_2D)
                .format(COLOR_FORMAT)
                .extent(vk::Extent3D { width: COLOR_WIDTH, height: COLOR_HEIGHT, depth: 1 })
                .mip_levels(1)
                .array_layers(1)
                .samples(vk::SampleCountFlags::TYPE_1)
                .tiling(vk::ImageTiling::OPTIMAL)
                .usage(vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_SRC)
                .sharing_mode(vk::SharingMode::EXCLUSIVE)
                .initial_layout(vk::ImageLayout::UNDEFINED);
            let color_image = ctx
                .device
                .create_image(&image_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateImage failed: {e:?}"))?;
            let image_requirements = ctx.device.get_image_memory_requirements(color_image);
            let image_alloc_info = vk::MemoryAllocateInfo::default()
                .allocation_size(image_requirements.size)
                .memory_type_index(ctx.device_local_memory_type);
            let color_memory = ctx
                .device
                .allocate_memory(&image_alloc_info, None)
                .map_err(|e| anyhow::anyhow!("vkAllocateMemory (color image) failed: {e:?}"))?;
            ctx.device
                .bind_image_memory(color_image, color_memory, 0)
                .map_err(|e| anyhow::anyhow!("vkBindImageMemory failed: {e:?}"))?;

            let view_info = vk::ImageViewCreateInfo::default()
                .image(color_image)
                .view_type(vk::ImageViewType::TYPE_2D)
                .format(COLOR_FORMAT)
                .subresource_range(vk::ImageSubresourceRange {
                    aspect_mask: vk::ImageAspectFlags::COLOR,
                    base_mip_level: 0,
                    level_count: 1,
                    base_array_layer: 0,
                    layer_count: 1,
                });
            let color_view = ctx
                .device
                .create_image_view(&view_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateImageView failed: {e:?}"))?;

            let framebuffer_attachments = [color_view];
            let framebuffer_info = vk::FramebufferCreateInfo::default()
                .render_pass(render_pass)
                .attachments(&framebuffer_attachments)
                .width(COLOR_WIDTH)
                .height(COLOR_HEIGHT)
                .layers(1);
            let framebuffer = ctx
                .device
                .create_framebuffer(&framebuffer_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateFramebuffer failed: {e:?}"))?;

            let readback_size = (COLOR_WIDTH as vk::DeviceSize) * (COLOR_HEIGHT as vk::DeviceSize) * 4;
            let buffer_info = vk::BufferCreateInfo::default()
                .size(readback_size)
                .usage(vk::BufferUsageFlags::TRANSFER_DST)
                .sharing_mode(vk::SharingMode::EXCLUSIVE);
            let readback_buffer = ctx
                .device
                .create_buffer(&buffer_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateBuffer (readback) failed: {e:?}"))?;
            let buffer_requirements = ctx.device.get_buffer_memory_requirements(readback_buffer);
            let buffer_alloc_info = vk::MemoryAllocateInfo::default()
                .allocation_size(buffer_requirements.size)
                .memory_type_index(ctx.host_visible_memory_type);
            let readback_memory = ctx
                .device
                .allocate_memory(&buffer_alloc_info, None)
                .map_err(|e| anyhow::anyhow!("vkAllocateMemory (readback) failed: {e:?}"))?;
            ctx.device
                .bind_buffer_memory(readback_buffer, readback_memory, 0)
                .map_err(|e| anyhow::anyhow!("vkBindBufferMemory (readback) failed: {e:?}"))?;

            let command_pool_info =
                vk::CommandPoolCreateInfo::default().queue_family_index(ctx.queue_family_index);
            let command_pool = ctx
                .device
                .create_command_pool(&command_pool_info, None)
                .map_err(|e| anyhow::anyhow!("vkCreateCommandPool failed: {e:?}"))?;

            Ok(FurPipeline {
                vert_module,
                frag_module,
                render_pass,
                pipeline_layout,
                pipeline,
                color_image,
                color_memory,
                color_view,
                framebuffer,
                readback_buffer,
                readback_memory,
                command_pool,
            })
        }
    }

    /// Renders one frame, copies it to the host-visible readback buffer,
    /// and returns the raw RGBA8 bytes (tightly packed, width*height*4).
    fn render_frame(&self, ctx: &VulkanContext, push: &PushConstants) -> anyhow::Result<Vec<u8>> {
        unsafe {
            let cmd_alloc_info = vk::CommandBufferAllocateInfo::default()
                .command_pool(self.command_pool)
                .level(vk::CommandBufferLevel::PRIMARY)
                .command_buffer_count(1);
            let cmd_buffers = ctx
                .device
                .allocate_command_buffers(&cmd_alloc_info)
                .map_err(|e| anyhow::anyhow!("vkAllocateCommandBuffers failed: {e:?}"))?;
            let cmd = cmd_buffers[0];

            let begin_info =
                vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT);
            ctx.device
                .begin_command_buffer(cmd, &begin_info)
                .map_err(|e| anyhow::anyhow!("vkBeginCommandBuffer failed: {e:?}"))?;

            let clear_values = [vk::ClearValue { color: vk::ClearColorValue { float32: [0.0, 0.0, 0.0, 1.0] } }];
            let render_pass_begin = vk::RenderPassBeginInfo::default()
                .render_pass(self.render_pass)
                .framebuffer(self.framebuffer)
                .render_area(vk::Rect2D {
                    offset: vk::Offset2D { x: 0, y: 0 },
                    extent: vk::Extent2D { width: COLOR_WIDTH, height: COLOR_HEIGHT },
                })
                .clear_values(&clear_values);
            ctx.device
                .cmd_begin_render_pass(cmd, &render_pass_begin, vk::SubpassContents::INLINE);
            ctx.device.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::GRAPHICS, self.pipeline);
            let push_bytes = std::slice::from_raw_parts(
                (push as *const PushConstants) as *const u8,
                std::mem::size_of::<PushConstants>(),
            );
            ctx.device.cmd_push_constants(
                cmd,
                self.pipeline_layout,
                vk::ShaderStageFlags::FRAGMENT,
                0,
                push_bytes,
            );
            ctx.device.cmd_draw(cmd, 3, 1, 0, 0);
            ctx.device.cmd_end_render_pass(cmd);

            let copy_region = vk::BufferImageCopy::default()
                .buffer_offset(0)
                .buffer_row_length(0)
                .buffer_image_height(0)
                .image_subresource(vk::ImageSubresourceLayers {
                    aspect_mask: vk::ImageAspectFlags::COLOR,
                    mip_level: 0,
                    base_array_layer: 0,
                    layer_count: 1,
                })
                .image_offset(vk::Offset3D { x: 0, y: 0, z: 0 })
                .image_extent(vk::Extent3D { width: COLOR_WIDTH, height: COLOR_HEIGHT, depth: 1 });
            ctx.device.cmd_copy_image_to_buffer(
                cmd,
                self.color_image,
                vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                self.readback_buffer,
                &[copy_region],
            );

            ctx.device
                .end_command_buffer(cmd)
                .map_err(|e| anyhow::anyhow!("vkEndCommandBuffer failed: {e:?}"))?;

            let fence = ctx
                .device
                .create_fence(&vk::FenceCreateInfo::default(), None)
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

            let readback_size = (COLOR_WIDTH as usize) * (COLOR_HEIGHT as usize) * 4;
            let ptr = ctx
                .device
                .map_memory(self.readback_memory, 0, readback_size as vk::DeviceSize, vk::MemoryMapFlags::empty())
                .map_err(|e| anyhow::anyhow!("vkMapMemory (readback) failed: {e:?}"))?;
            let bytes = std::slice::from_raw_parts(ptr as *const u8, readback_size).to_vec();
            ctx.device.unmap_memory(self.readback_memory);

            Ok(bytes)
        }
    }

    fn destroy(&self, ctx: &VulkanContext) {
        unsafe {
            ctx.device.destroy_command_pool(self.command_pool, None);
            ctx.device.destroy_buffer(self.readback_buffer, None);
            ctx.device.free_memory(self.readback_memory, None);
            ctx.device.destroy_framebuffer(self.framebuffer, None);
            ctx.device.destroy_image_view(self.color_view, None);
            ctx.device.destroy_image(self.color_image, None);
            ctx.device.free_memory(self.color_memory, None);
            ctx.device.destroy_pipeline(self.pipeline, None);
            ctx.device.destroy_pipeline_layout(self.pipeline_layout, None);
            ctx.device.destroy_render_pass(self.render_pass, None);
            ctx.device.destroy_shader_module(self.frag_module, None);
            ctx.device.destroy_shader_module(self.vert_module, None);
        }
    }
}

/// GLSL's `fract(x)` is `x - floor(x)`, always non-negative — unlike Rust's
/// `f32::fract`, which keeps the sign of `x` (e.g. `(-1.5).fract() ==
/// -0.5`). The shader is GLSL; the CPU-side reference has to match GLSL's
/// definition exactly or every negative accumulator would show up as a
/// false "mismatch" against a real GPU that's computing correctly.
fn glsl_fract(x: f32) -> f32 {
    x - x.floor()
}

const TAU: f32 = std::f32::consts::TAU;

/// GLSL's `mod(x, y)` is `x - y * floor(x / y)`, not Rust's `%` (which keeps
/// the sign of `x`, like Rust's own `f32::fract`) — same family of
/// cross-language mismatch as `glsl_fract` above, matched exactly for the
/// same reason: the shader is GLSL, so the CPU reference has to use GLSL's
/// definition or it isn't actually checking the same computation.
fn glsl_mod(x: f32, y: f32) -> f32 {
    x - y * (x / y).floor()
}

/// See `wrapAngle` in fur.frag: bounds a trig argument to [0, TAU) before
/// evaluating sin/cos, since GPU-hardware and CPU-libm sin/cos are only
/// guaranteed to agree closely for well-conditioned (small) arguments — this
/// shader's raw arguments reach into the tens of thousands of radians with
/// 4000 iterations, which is real GPU/CPU divergence, not a hardware defect.
fn wrap_angle(x: f32) -> f32 {
    glsl_mod(x, TAU)
}

/// Recomputes `fur.frag`'s output at pixel (px, py) on the CPU — the same
/// formula, in the same order, given the same push constants. `gl_FragCoord`
/// is the pixel center (integer + 0.5) per the Vulkan spec.
fn expected_pixel(px: u32, py: u32, iterations: u32, time: f32) -> [f32; 3] {
    let uv_x = (px as f32 + 0.5) * 0.01;
    let uv_y = (py as f32 + 0.5) * 0.01;
    let mut acc = [0f32; 3];
    for i in 0..iterations {
        let f = i as f32 + time;
        acc[0] += wrap_angle(uv_x * f).sin() * wrap_angle(uv_y * f).cos();
        acc[1] += wrap_angle(uv_x * f * 1.3).cos() * wrap_angle(uv_y * f * 0.7).sin();
        acc[2] += wrap_angle((uv_x + uv_y) * f * 0.5).sin();
    }
    [glsl_fract(acc[0]), glsl_fract(acc[1]), glsl_fract(acc[2])]
}

/// Renders `fur.frag` under load for `duration`, checking a sampled grid of
/// pixels every frame against the CPU-recomputed expected value. `on_tick`
/// mirrors stress::run's watchdog contract: return `false` to abort early.
pub fn run(
    ctx: &VulkanContext,
    duration: Duration,
    mut on_tick: impl FnMut(Duration) -> bool,
) -> anyhow::Result<FurTestResult> {
    let pipeline = FurPipeline::new(ctx)?;

    let started = Instant::now();
    let mut frames_rendered = 0u32;
    let mut mismatches = 0u32;
    let mut pixels_checked = 0u32;
    let mut aborted_for_safety = false;

    let result = (|| -> anyhow::Result<()> {
        while started.elapsed() < duration {
            let elapsed = started.elapsed();
            let push = PushConstants { iterations: FUR_ITERATIONS, time: elapsed.as_secs_f32() };
            let pixels = pipeline.render_frame(ctx, &push)?;
            frames_rendered += 1;

            let step_x = COLOR_WIDTH / SAMPLE_GRID;
            let step_y = COLOR_HEIGHT / SAMPLE_GRID;
            for gy in 0..SAMPLE_GRID {
                for gx in 0..SAMPLE_GRID {
                    let px = gx * step_x + step_x / 2;
                    let py = gy * step_y + step_y / 2;
                    let offset = ((py * COLOR_WIDTH + px) * 4) as usize;
                    let actual = [
                        pixels[offset] as f32 / 255.0,
                        pixels[offset + 1] as f32 / 255.0,
                        pixels[offset + 2] as f32 / 255.0,
                    ];
                    let expected = expected_pixel(px, py, push.iterations, push.time);
                    pixels_checked += 1;
                    let is_mismatch = (0..3).any(|c| (actual[c] - expected[c]).abs() > MISMATCH_EPSILON);
                    if is_mismatch {
                        mismatches += 1;
                    }
                }
            }

            if !on_tick(started.elapsed()) {
                aborted_for_safety = true;
                break;
            }
        }
        Ok(())
    })();

    pipeline.destroy(ctx);
    result?;

    Ok(FurTestResult {
        frames_rendered,
        duration: started.elapsed(),
        mismatches,
        pixels_checked,
        aborted_for_safety,
    })
}
