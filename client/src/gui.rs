//! The window a seller actually sees. Runs the real pipeline (NVML read,
//! Vulkan stress test, Vulkan VRAM test, report submission) on a background
//! thread — `eframe`'s event loop owns the main thread and can't block on
//! multi-minute Vulkan dispatches — and streams `Progress` messages back
//! over a channel so the window can show live numbers instead of a static
//! "please wait". This exists specifically because a bare console window
//! silently reading hardware IDs and phoning home looks like malware; a
//! named window with visible, moving numbers doesn't.

use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use crate::fingerprint::Fingerprint;
use crate::report::{sample_from_telemetry, CertifyRequest, TelemetrySample};
use crate::vulkan::VulkanContext;
use crate::{nvml, report, vulkan};

const STRESS_TEST_DURATION: Duration = Duration::from_secs(5 * 60);
const VRAM_TEST_DURATION: Duration = Duration::from_secs(10 * 60);
const VRAM_TEST_FRACTION: f64 = 0.85;

pub enum Progress {
    DetectedGpu { name: String, vram_mb: u64 },
    Fingerprint(String),
    VulkanDevice,
    StressStarted,
    StressSample(TelemetrySample),
    StressDone { dispatch_count: u32 },
    VramStarted,
    VramProgress { passes_run: u32, total_errors: u64, elapsed_ms: u64 },
    VramDone { passes_run: u32, total_errors: u64 },
    Submitting,
    Done { report_url: String, badge_url: String, passed: bool },
    Failed(String),
}

/// Runs on a background thread; every `?` failure is caught and reported
/// through the channel as `Progress::Failed` rather than panicking the
/// worker thread silently, since a Vulkan/NVML error here is a normal
/// outcome (unsupported GPU, driver issue) the seller needs to see, not a
/// crash.
pub fn run_pipeline(tx: Sender<Progress>) {
    if let Err(e) = run_pipeline_inner(&tx) {
        let _ = tx.send(Progress::Failed(e.to_string()));
    }
}

fn run_pipeline_inner(tx: &Sender<Progress>) -> anyhow::Result<()> {
    let nvml = nvml::Nvml::load().map_err(|e| {
        anyhow::anyhow!(
            "no supported GPU found (NVML load failed: {e}). AMD support via ADL is scaffolded \
             but not wired in yet."
        )
    })?;
    let telemetry = nvml.read_primary_gpu()?;
    tx.send(Progress::DetectedGpu {
        name: telemetry.name.clone(),
        vram_mb: telemetry.vram_total_bytes / 1_048_576,
    })?;

    let fingerprint = Fingerprint::from_telemetry(&telemetry);
    tx.send(Progress::Fingerprint(fingerprint.hash.clone()))?;

    let ctx = VulkanContext::new()?;
    tx.send(Progress::VulkanDevice)?;

    tx.send(Progress::StressStarted)?;
    let mut telemetry_series = Vec::new();
    let stress_started = std::time::Instant::now();
    let dispatch_count = vulkan::stress::run(&ctx, STRESS_TEST_DURATION, |elapsed| {
        if let Ok(sample_telemetry) = nvml.read_primary_gpu() {
            let sample = sample_from_telemetry(elapsed, &sample_telemetry);
            let _ = tx.send(Progress::StressSample(sample.clone()));
            telemetry_series.push(sample);
        }
    })?;
    tx.send(Progress::StressDone { dispatch_count })?;
    let stress_report = report::build_stress_report(telemetry_series, dispatch_count, stress_started.elapsed());

    tx.send(Progress::VramStarted)?;
    let vram_result = vulkan::vram_test::run(
        &ctx,
        telemetry.vram_total_bytes,
        VRAM_TEST_FRACTION,
        VRAM_TEST_DURATION,
        |passes_run, total_errors, elapsed| {
            let _ = tx.send(Progress::VramProgress {
                passes_run,
                total_errors,
                elapsed_ms: elapsed.as_millis() as u64,
            });
        },
    )?;
    tx.send(Progress::VramDone {
        passes_run: vram_result.passes_run,
        total_errors: vram_result.total_errors,
    })?;
    let vram_report = report::VramTestReport::from_result(&vram_result);
    let passed = vram_report.total_errors == 0;

    let request = CertifyRequest {
        client_version: env!("CARGO_PKG_VERSION"),
        fingerprint,
        device_name: telemetry.name.clone(),
        stress_test: stress_report,
        vram_test: vram_report,
    };

    tx.send(Progress::Submitting)?;
    let response = report::submit(&request)?;
    tx.send(Progress::Done {
        report_url: response.report_url,
        badge_url: response.badge_url,
        passed,
    })?;

    Ok(())
}

pub struct GpuCertApp {
    rx: Receiver<Progress>,
    device_name: Option<String>,
    vram_mb: Option<u64>,
    fingerprint: Option<String>,
    phase: Phase,
    latest_sample: Option<TelemetrySample>,
    stress_dispatch_count: Option<u32>,
    vram_passes: u32,
    vram_errors: u64,
    elapsed_ms: u64,
    result: Option<Result<(String, String, bool), String>>,
}

#[derive(PartialEq)]
enum Phase {
    ReadingGpu,
    Stressing,
    TestingVram,
    Submitting,
    Done,
}

// Design tokens, taken directly from the anurfi website/board palette
// (same --bg/--fg/--muted/--accent values as anurfi.net and anurfi-board's
// globals.css) rather than inventing a separate visual identity for this
// tool. Pass/fail are the one addition: muted, warm-leaning colors chosen
// to sit inside this palette rather than the generic saturated
// green/red — status colors, used nowhere else.
mod tokens {
    use egui::Color32;
    pub const BG: Color32 = Color32::from_rgb(0x14, 0x12, 0x0F);
    pub const SURFACE: Color32 = Color32::from_rgb(0x1A, 0x18, 0x14);
    pub const INK: Color32 = Color32::from_rgb(0xF2, 0xEF, 0xE8);
    pub const MUTED: Color32 = Color32::from_rgb(0x8A, 0x85, 0x78);
    pub const MUTED_2: Color32 = Color32::from_rgb(0x6B, 0x66, 0x58);
    pub const LINE: Color32 = Color32::from_rgb(0x2A, 0x28, 0x25);
    pub const ACCENT: Color32 = Color32::from_rgb(0xB5, 0x50, 0x1F);
    pub const PASS: Color32 = Color32::from_rgb(0x7A, 0x9B, 0x6E);
    pub const FAIL: Color32 = Color32::from_rgb(0xB2, 0x3B, 0x32);
}

/// Set once at startup: anurfi's palette as egui's base Visuals, so every
/// default-styled widget already matches without per-widget overrides.
fn configure_style(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = tokens::BG;
    visuals.override_text_color = Some(tokens::INK);
    visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, tokens::LINE);
    visuals.hyperlink_color = tokens::ACCENT;
    visuals.selection.bg_fill = tokens::ACCENT;
    // Striped sensor-grid rows: a faint lighten of SURFACE, not egui's
    // default gray, so the stripe reads as part of the same palette.
    visuals.faint_bg_color = egui::Color32::from_rgb(0x20, 0x1D, 0x18);
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style_of(egui::Theme::Dark)).clone();
    style.spacing.item_spacing = egui::vec2(6.0, 6.0);
    ctx.set_style_of(egui::Theme::Dark, style);
}

/// Small uppercase letter-spaced label — the same "eyebrow" treatment
/// anurfi's own site/board use for section labels (see .eyebrow in
/// anurfi-board/app/globals.css), reused here instead of inventing a new
/// label style.
fn eyebrow(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text).color(tokens::MUTED).size(11.0).extra_letter_spacing(0.6)
}

/// One row of the sensor grid: muted label, tabular-monospace value in its
/// own aligned column — an `egui::Grid` row, not a manually right-aligned
/// horizontal layout, specifically so values line up across every row the
/// way GPU-Z's/HWiNFO's own sensor tables do.
fn grid_row(ui: &mut egui::Ui, label: &str, value: impl Into<String>, value_color: egui::Color32) {
    ui.label(egui::RichText::new(label).color(tokens::MUTED).size(12.0));
    ui.label(egui::RichText::new(value.into()).monospace().color(value_color).size(12.0));
    ui.end_row();
}

fn format_mmss(ms: u64) -> String {
    let total_secs = ms / 1000;
    format!("{}:{:02}", total_secs / 60, total_secs % 60)
}

impl GpuCertApp {
    pub fn new(cc: &eframe::CreationContext<'_>, rx: Receiver<Progress>) -> Self {
        configure_style(&cc.egui_ctx);
        GpuCertApp {
            rx,
            device_name: None,
            vram_mb: None,
            fingerprint: None,
            phase: Phase::ReadingGpu,
            latest_sample: None,
            stress_dispatch_count: None,
            vram_passes: 0,
            vram_errors: 0,
            elapsed_ms: 0,
            result: None,
        }
    }

    fn drain_progress(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Progress::DetectedGpu { name, vram_mb } => {
                    self.device_name = Some(name);
                    self.vram_mb = Some(vram_mb);
                }
                Progress::Fingerprint(hash) => self.fingerprint = Some(hash),
                Progress::VulkanDevice => {}
                Progress::StressStarted => {
                    self.phase = Phase::Stressing;
                    self.elapsed_ms = 0;
                }
                Progress::StressSample(sample) => {
                    self.elapsed_ms = sample.elapsed_ms;
                    self.latest_sample = Some(sample);
                }
                Progress::StressDone { dispatch_count } => self.stress_dispatch_count = Some(dispatch_count),
                Progress::VramStarted => {
                    self.phase = Phase::TestingVram;
                    self.elapsed_ms = 0;
                }
                Progress::VramProgress { passes_run, total_errors, elapsed_ms } => {
                    self.vram_passes = passes_run;
                    self.vram_errors = total_errors;
                    self.elapsed_ms = elapsed_ms;
                }
                Progress::VramDone { passes_run, total_errors } => {
                    self.vram_passes = passes_run;
                    self.vram_errors = total_errors;
                }
                Progress::Submitting => self.phase = Phase::Submitting,
                Progress::Done { report_url, badge_url, passed } => {
                    self.phase = Phase::Done;
                    self.result = Some(Ok((report_url, badge_url, passed)));
                }
                Progress::Failed(err) => {
                    self.phase = Phase::Done;
                    self.result = Some(Err(err));
                }
            }
        }
    }
}

impl eframe::App for GpuCertApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.drain_progress();
        // Test phases run for minutes; repaint on a timer (not just on
        // message arrival) so the window never looks frozen between ticks.
        ui.ctx().request_repaint_after(Duration::from_millis(200));

        egui::CentralPanel::default().show(ui, |ui| {
            ui.add_space(14.0);
            ui.horizontal(|ui| {
                let (rect, _) = ui.allocate_exact_size(egui::vec2(24.0, 24.0), egui::Sense::hover());
                draw_icon(ui.painter(), rect);
                ui.add_space(8.0);
                ui.label(
                    egui::RichText::new("GPU CERT")
                        .color(tokens::INK)
                        .size(14.0)
                        .strong()
                        .extra_letter_spacing(1.2),
                );
            });
            ui.add_space(10.0);

            ui.label(eyebrow(match self.phase {
                Phase::ReadingGpu => "Reading device",
                Phase::Stressing => "Stress test",
                Phase::TestingVram => "VRAM test",
                Phase::Submitting => "Submitting",
                Phase::Done => "Done",
            }));

            let (total_duration, show_progress) = match self.phase {
                Phase::Stressing => (STRESS_TEST_DURATION, true),
                Phase::TestingVram => (VRAM_TEST_DURATION, true),
                _ => (Duration::ZERO, false),
            };
            if show_progress {
                ui.add_space(6.0);
                let fraction = (self.elapsed_ms as f32 / total_duration.as_millis() as f32).min(1.0);
                ui.add(egui::ProgressBar::new(fraction).fill(tokens::ACCENT).desired_height(4.0).corner_radius(2.0));
                ui.add_space(2.0);
                ui.label(
                    egui::RichText::new(format!(
                        "{} / {}",
                        format_mmss(self.elapsed_ms),
                        format_mmss(total_duration.as_millis() as u64)
                    ))
                    .color(tokens::MUTED_2)
                    .size(11.0),
                );
            }

            // A persistent, always-visible grid (GPU-Z/HWiNFO's own layout
            // language: a fixed set of sensor rows that fill in and update
            // live, not a panel that restructures per phase) rather than
            // swapping which rows exist depending on test phase — that
            // reflow was the "weird" part of the previous layout.
            ui.add_space(10.0);
            egui::Frame::new()
                .fill(tokens::SURFACE)
                .stroke(egui::Stroke::new(1.0, tokens::LINE))
                .corner_radius(4.0)
                .inner_margin(egui::Margin::symmetric(12, 8))
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    let dash = "—".to_string();
                    egui::Grid::new("sensor_grid")
                        .num_columns(2)
                        .spacing(egui::vec2(12.0, 5.0))
                        .striped(true)
                        .show(ui, |ui| {
                            grid_row(ui, "Device", self.device_name.clone().unwrap_or_else(|| dash.clone()), tokens::INK);
                            grid_row(
                                ui,
                                "VRAM",
                                self.vram_mb.map(|v| format!("{v} MB")).unwrap_or_else(|| dash.clone()),
                                tokens::INK,
                            );
                            grid_row(
                                ui,
                                "Temp",
                                self.latest_sample.as_ref().map(|s| format!("{}°C", s.temperature_c)).unwrap_or_else(|| dash.clone()),
                                tokens::INK,
                            );
                            grid_row(
                                ui,
                                "Load",
                                self.latest_sample.as_ref().map(|s| format!("{}%", s.utilization_pct)).unwrap_or_else(|| dash.clone()),
                                tokens::INK,
                            );
                            grid_row(
                                ui,
                                "Power",
                                self.latest_sample.as_ref().map(|s| format!("{} W", s.power_draw_mw / 1000)).unwrap_or_else(|| dash.clone()),
                                tokens::INK,
                            );
                            grid_row(
                                ui,
                                "Core clock",
                                self.latest_sample.as_ref().map(|s| format!("{} MHz", s.graphics_clock_mhz)).unwrap_or_else(|| dash.clone()),
                                tokens::INK,
                            );
                            grid_row(
                                ui,
                                "Memory clock",
                                self.latest_sample.as_ref().map(|s| format!("{} MHz", s.memory_clock_mhz)).unwrap_or_else(|| dash.clone()),
                                tokens::INK,
                            );
                            let vram_active = matches!(self.phase, Phase::TestingVram | Phase::Done);
                            grid_row(ui, "VRAM passes", if vram_active { self.vram_passes.to_string() } else { dash.clone() }, tokens::INK);
                            grid_row(
                                ui,
                                "VRAM errors",
                                if vram_active { self.vram_errors.to_string() } else { dash.clone() },
                                if self.vram_errors > 0 { tokens::FAIL } else { tokens::INK },
                            );
                            grid_row(
                                ui,
                                "Stress dispatches",
                                self.stress_dispatch_count.map(|d| d.to_string()).unwrap_or_else(|| dash.clone()),
                                tokens::INK,
                            );
                            grid_row(ui, "Fingerprint", self.fingerprint.clone().unwrap_or_else(|| dash.clone()), tokens::MUTED_2);
                        });
                });

            if self.phase == Phase::Done {
                ui.add_space(12.0);
                match &self.result {
                    Some(Ok((report_url, _badge_url, passed))) => {
                        let (text, color) = if *passed {
                            ("PASS", tokens::PASS)
                        } else {
                            ("FAIL", tokens::FAIL)
                        };
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new(text).color(color).strong().size(16.0));
                            ui.add_space(10.0);
                            ui.hyperlink_to("View report >", report_url);
                        });
                    }
                    Some(Err(err)) => {
                        ui.label(egui::RichText::new("Could not complete test").color(tokens::FAIL).strong());
                        ui.label(egui::RichText::new(err).color(tokens::MUTED).size(11.0));
                    }
                    None => {}
                }
            }
        });
    }
}

/// GPU Cert's own mark, not a reuse of the anurfi "A" logo — this is a
/// different product domain, so it gets its own identity even though it
/// shares anurfi's palette. Drawn in the same visual language as the
/// anurfi mark though: a single bold stroke, rounded caps, one accent
/// color, no fill, no gradient (see anurfi-board/components/Logo.tsx).
/// Subject here is a chip/die outline with a couple of lead pins, read as
/// "hardware", the way anurfi's mark reads as an "A" — both abstract
/// geometry, not illustration.
fn draw_icon(painter: &egui::Painter, rect: egui::Rect) {
    let stroke_width = rect.width() * 0.11;
    let stroke = egui::Stroke::new(stroke_width, tokens::ACCENT);
    let inset = rect.width() * 0.22;
    let body = egui::Rect::from_min_max(rect.min + egui::vec2(inset, inset), rect.max - egui::vec2(inset, inset));

    painter.add(egui::Shape::rect_stroke(body, rect.width() * 0.08, stroke, egui::StrokeKind::Middle));

    let pin_len = inset * 0.85;
    for frac in [0.32, 0.68] {
        let x = rect.min.x + rect.width() * frac;
        painter.line_segment([egui::pos2(x, rect.min.y), egui::pos2(x, rect.min.y + pin_len)], stroke);
        painter.line_segment([egui::pos2(x, rect.max.y - pin_len), egui::pos2(x, rect.max.y)], stroke);
    }
}
