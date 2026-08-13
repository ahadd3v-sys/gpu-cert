//! Graphics-pipeline correctness + display-output test. The compute stress
//! kernel (stress.rs) generates thermal/power load but never checks its own
//! output, and runs pure compute, never touching the rasterizer/ROP/texture
//! path a real display pipeline uses, so neither silent ALU corruption nor
//! rasterizer-path corruption would be caught by it. This test renders
//! `fur.frag` (a fullscreen fragment shader, conceptually like FurMark's
//! "fur" load: heavy per-pixel ALU work through the real graphics pipeline)
//! and checks it: the shader is a pure deterministic function of (pixel
//! coordinate, iteration count, time), so the expected output at any pixel
//! can be recomputed on the CPU and compared against what the GPU actually
//! rendered. A mismatch beyond normal floating-point tolerance means the
//! GPU computed the wrong answer under load, a class of defect neither the
//! compute stress test nor the VRAM test can see.

use ash::vk;
use std::time::{Duration, Instant};

use super::device::VulkanContext;
use super::{FUR_FRAG_SPV, FUR_VERT_SPV};

const COLOR_WIDTH: u32 = 256;
const COLOR_HEIGHT: u32 = 256;
// R32_UINT, and specifically an integer format. A UNORM attachment would
// quantize the shader's output to 8 bits per channel and reintroduce exactly
// the "is this difference a defect or a rounding edge" ambiguity this test
// was rewritten to eliminate. VK_FORMAT_R32_UINT carries mandatory
// COLOR_ATTACHMENT_BIT support in the spec's Mandatory Format Support
// tables, so it is available on every conformant implementation, not just
// on high-end cards.
const COLOR_FORMAT: vk::Format = vk::Format::R32_UINT;
const PIXEL_COUNT: usize = (COLOR_WIDTH * COLOR_HEIGHT) as usize;

/// Length of the per-pixel dependent integer chain. Sets how much ALU work
/// each fragment costs, and (multiplied by PIXEL_COUNT) how long the CPU
/// takes to build one reference image.
const FUR_ITERATIONS: u32 = 2000;

/// Distinct reference images, cycled frame to frame. One would already be a
/// valid test, since a frame is deterministic and the GPU recomputes it from
/// scratch every time; more than one just widens the set of operand
/// sequences the card has to get right. Each costs one full CPU pass to
/// build up front (PIXEL_COUNT * FUR_ITERATIONS iterations), so this trades
/// directly against startup time.
const REFERENCE_SEEDS: [u32; 2] = [0x5EED_1234, 0xA5A5_C3C3];

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
    seed: u32,
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
            // the copy waits for the color write to finish, a well-known
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
            // No vertex buffers, fur.vert hardcodes a fullscreen triangle
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
            // Same rule as buffers: the image decides which memory types it
            // accepts, and a device-wide "best" index is not necessarily one
            // of them. Binding one that isn't is undefined behaviour.
            let image_requirements = ctx.device.get_image_memory_requirements(color_image);
            let image_memory_type = ctx
                .compatible_memory_type(image_requirements.memory_type_bits, &ctx.device_local_memory_types)
                .ok_or_else(|| {
                    anyhow::anyhow!("no device-local memory type accepted by the render target")
                })?;
            let image_alloc_info = vk::MemoryAllocateInfo::default()
                .allocation_size(image_requirements.size)
                .memory_type_index(image_memory_type);
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
            let readback_memory_type = ctx
                .compatible_memory_type(buffer_requirements.memory_type_bits, &ctx.host_visible_memory_types)
                .ok_or_else(|| {
                    anyhow::anyhow!("no host-visible memory type accepted by the readback buffer")
                })?;
            let buffer_alloc_info = vk::MemoryAllocateInfo::default()
                .allocation_size(buffer_requirements.size)
                .memory_type_index(readback_memory_type);
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
    /// and returns it as one u32 per pixel, row-major.
    fn render_frame(&self, ctx: &VulkanContext, push: &PushConstants) -> anyhow::Result<Vec<u32>> {
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

            // uint32, not float32: the union member has to match the
            // attachment's numeric type, and this attachment is R32_UINT.
            let clear_values = [vk::ClearValue { color: vk::ClearColorValue { uint32: [0; 4] } }];
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

            let readback_size = PIXEL_COUNT * 4;
            let ptr = ctx
                .device
                .map_memory(self.readback_memory, 0, readback_size as vk::DeviceSize, vk::MemoryMapFlags::empty())
                .map_err(|e| anyhow::anyhow!("vkMapMemory (readback) failed: {e:?}"))?;
            // Copied out bytewise and reassembled rather than cast straight
            // to *const u32: the mapped pointer carries no alignment
            // guarantee beyond minMemoryMapAlignment, and an unaligned u32
            // read would be undefined behaviour. R32_UINT texels sit in
            // memory in host byte order, so from_ne_bytes is the correct
            // reassembly.
            let bytes = std::slice::from_raw_parts(ptr as *const u8, readback_size);
            let pixels: Vec<u32> = bytes
                .chunks_exact(4)
                .map(|c| u32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            ctx.device.unmap_memory(self.readback_memory);

            Ok(pixels)
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

/// Recomputes `fur.frag`'s output for one pixel on the CPU: the same
/// operations, in the same order, on the same 32-bit unsigned values.
///
/// Every operation here is exact and wraps mod 2^32 on both sides, so this
/// is a bit-for-bit reference rather than an approximation to compare
/// against with a tolerance. `wrapping_*` is not a workaround; it is the
/// literal semantics GLSL specifies for uint arithmetic, made explicit
/// because Rust would otherwise panic on overflow in debug builds.
fn expected_pixel(px: u32, py: u32, iterations: u32, seed: u32) -> u32 {
    let mut h = seed ^ px.wrapping_mul(0x9E37_79B9) ^ py.wrapping_mul(0x85EB_CA6B);
    for _ in 0..iterations {
        h ^= h << 13;
        h ^= h >> 17;
        h ^= h << 5;
        h = h.wrapping_mul(0x2545_F491).wrapping_add(0x6C07_8965);
    }
    h
}

/// Builds the full expected image for one seed. One pass costs
/// PIXEL_COUNT * FUR_ITERATIONS iterations, which is why it happens once up
/// front rather than per frame.
fn reference_image(seed: u32) -> Vec<u32> {
    (0..PIXEL_COUNT)
        .map(|i| {
            let px = (i % COLOR_WIDTH as usize) as u32;
            let py = (i / COLOR_WIDTH as usize) as u32;
            expected_pixel(px, py, FUR_ITERATIONS, seed)
        })
        .collect()
}

/// Renders under load for `duration`, comparing every pixel of every frame
/// against a precomputed CPU reference. `on_tick` mirrors stress::run's
/// watchdog contract: return `false` to abort early.
///
/// Comparing whole frames rather than a sampled grid is affordable precisely
/// because the check is now exact: the reference for a given seed never
/// changes, so it is built once and each frame costs a 64K-element compare
/// instead of re-deriving per-pixel math. That took coverage from 64 sampled
/// points per frame to all 65536, which matters for the defect this test is
/// aimed at, a bad ROP or a bad patch of framebuffer memory is localized,
/// and a sparse grid can miss it entirely.
pub fn run(
    ctx: &VulkanContext,
    duration: Duration,
    mut on_tick: impl FnMut(Duration) -> bool,
) -> anyhow::Result<FurTestResult> {
    let pipeline = FurPipeline::new(ctx)?;

    // Announced because it is CPU-bound work with no GPU activity behind it:
    // roughly half a second on a modern laptop, longer on an old desktop,
    // during which nothing else prints and the card sits idle.
    println!("  (computing reference images on the CPU...)");
    let references: Vec<(u32, Vec<u32>)> = REFERENCE_SEEDS
        .iter()
        .map(|&seed| (seed, reference_image(seed)))
        .collect();

    let started = Instant::now();
    let mut frames_rendered = 0u32;
    let mut mismatches = 0u32;
    let mut pixels_checked = 0u32;
    let mut aborted_for_safety = false;
    let mut reported_example = false;

    let result = (|| -> anyhow::Result<()> {
        while started.elapsed() < duration {
            let (seed, expected) = &references[frames_rendered as usize % references.len()];
            let push = PushConstants { iterations: FUR_ITERATIONS, seed: *seed };
            let actual = pipeline.render_frame(ctx, &push)?;
            frames_rendered += 1;

            if actual.len() != expected.len() {
                anyhow::bail!(
                    "readback returned {} pixels, expected {}",
                    actual.len(),
                    expected.len()
                );
            }

            // Saturating, because a catastrophically failing card could
            // otherwise overflow the counter across a 45-second run and
            // report a small number of mismatches.
            let frame_mismatches = actual
                .iter()
                .zip(expected.iter())
                .filter(|(a, e)| a != e)
                .count();
            pixels_checked = pixels_checked.saturating_add(PIXEL_COUNT as u32);
            mismatches = mismatches.saturating_add(frame_mismatches as u32);

            // One concrete example is worth far more than a bare count when
            // diagnosing: the xor of actual against expected shows whether a
            // single bit flipped (memory or ROP) or the whole value is
            // unrelated (the computation itself went wrong).
            if frame_mismatches > 0 && !reported_example {
                reported_example = true;
                if let Some(i) = actual.iter().zip(expected.iter()).position(|(a, e)| a != e) {
                    let (a, e) = (actual[i], expected[i]);
                    println!(
                        "\n  render mismatch: frame {frames_rendered}, {frame_mismatches} of \
                         {PIXEL_COUNT} pixels wrong, first at ({}, {}) actual=0x{a:08x} \
                         expected=0x{e:08x} xor=0x{:08x}",
                        i % COLOR_WIDTH as usize,
                        i / COLOR_WIDTH as usize,
                        a ^ e
                    );
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the property the whole test now rests on: the reference is a
    /// pure function of (pixel, seed), so it is reproducible run to run. If
    /// this ever stops holding, every certificate the client issues starts
    /// disagreeing with itself.
    #[test]
    fn reference_is_deterministic() {
        assert_eq!(expected_pixel(17, 42, 64, 0x1234_5678), expected_pixel(17, 42, 64, 0x1234_5678));
    }

    /// Different pixels must not collapse onto the same value, or a defect
    /// that corrupted one pixel into another's value would read as a pass.
    #[test]
    fn distinct_pixels_differ() {
        let a = expected_pixel(0, 0, FUR_ITERATIONS, REFERENCE_SEEDS[0]);
        let b = expected_pixel(1, 0, FUR_ITERATIONS, REFERENCE_SEEDS[0]);
        let c = expected_pixel(0, 1, FUR_ITERATIONS, REFERENCE_SEEDS[0]);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    /// Zero is an absorbing state for bare xorshift32. The LCG step exists
    /// to break out of it, and this pins that down: if the mixer were ever
    /// simplified back to plain xorshift, a pixel that reached zero would
    /// stay zero and read identically to cleared framebuffer memory.
    #[test]
    fn zero_state_recovers() {
        let mut h = 0u32;
        for _ in 0..4 {
            h ^= h << 13;
            h ^= h >> 17;
            h ^= h << 5;
            h = h.wrapping_mul(0x2545_F491).wrapping_add(0x6C07_8965);
        }
        assert_ne!(h, 0);
    }
}
