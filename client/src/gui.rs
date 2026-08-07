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
    VramProgress { passes_run: u32, total_errors: u64 },
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
            let _ = tx.send(Progress::StressSample(TelemetrySample {
                elapsed_ms: sample.elapsed_ms,
                temperature_c: sample.temperature_c,
                power_draw_mw: sample.power_draw_mw,
                graphics_clock_mhz: sample.graphics_clock_mhz,
                memory_clock_mhz: sample.memory_clock_mhz,
            }));
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
        |passes_run, total_errors| {
            let _ = tx.send(Progress::VramProgress { passes_run, total_errors });
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

// Design tokens. The window is styled as a small diagnostic instrument, not
// consumer app chrome: a graphite "chassis" holding a recessed "screen"
// that only live test data lives inside, in an amber-phosphor monospace —
// the CRT-multimeter/oscilloscope vernacular real hardware test tools use.
// Chassis vs. screen is a real structural distinction (static chrome vs.
// live readings), not decoration. Pass/fail colors are reserved strictly
// for verdict state and never used decoratively elsewhere.
mod tokens {
    use egui::Color32;
    pub const CHASSIS_BG: Color32 = Color32::from_rgb(0x1C, 0x1E, 0x22);
    pub const CHASSIS_INK: Color32 = Color32::from_rgb(0xC7, 0xCB, 0xD1);
    pub const CHASSIS_INK_DIM: Color32 = Color32::from_rgb(0x7D, 0x82, 0x8A);
    pub const SCREEN_BG: Color32 = Color32::from_rgb(0x14, 0x11, 0x0D);
    pub const PHOSPHOR: Color32 = Color32::from_rgb(0xE8, 0xA3, 0x3D);
    pub const PHOSPHOR_DIM: Color32 = Color32::from_rgb(0x8A, 0x67, 0x35);
    pub const PASS: Color32 = Color32::from_rgb(0x4C, 0xAF, 0x7D);
    pub const FAIL: Color32 = Color32::from_rgb(0xD6, 0x60, 0x4D);
    pub const HAIRLINE: Color32 = Color32::from_rgb(0x33, 0x36, 0x3C);
}

/// Set once at startup: dark chassis colors as egui's base Visuals, so
/// every default-styled widget (labels, separators) already matches
/// without per-widget overrides.
fn configure_style(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = tokens::CHASSIS_BG;
    visuals.override_text_color = Some(tokens::CHASSIS_INK);
    visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, tokens::HAIRLINE);
    visuals.hyperlink_color = tokens::PHOSPHOR;
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style_of(egui::Theme::Dark)).clone();
    style.spacing.item_spacing = egui::vec2(6.0, 8.0);
    ctx.set_style_of(egui::Theme::Dark, style);
}

/// A recessed instrument screen: darker than the chassis, with a hairline
/// top edge and a faint bottom highlight to read as inset rather than
/// flush with the surrounding panel. Everything painted inside is live
/// test data, in phosphor-colored monospace.
fn screen_frame() -> egui::Frame {
    egui::Frame::new()
        .fill(tokens::SCREEN_BG)
        .stroke(egui::Stroke::new(1.0, tokens::HAIRLINE))
        .corner_radius(4.0)
        .inner_margin(egui::Margin::symmetric(12, 10))
}

fn phosphor(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text).monospace().color(tokens::PHOSPHOR)
}

fn phosphor_dim(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text).monospace().color(tokens::PHOSPHOR_DIM).size(11.0)
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
                Progress::StressStarted => self.phase = Phase::Stressing,
                Progress::StressSample(sample) => self.latest_sample = Some(sample),
                Progress::StressDone { dispatch_count } => self.stress_dispatch_count = Some(dispatch_count),
                Progress::VramStarted => self.phase = Phase::TestingVram,
                Progress::VramProgress { passes_run, total_errors } => {
                    self.vram_passes = passes_run;
                    self.vram_errors = total_errors;
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
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                let (rect, _) = ui.allocate_exact_size(egui::vec2(30.0, 30.0), egui::Sense::hover());
                draw_gpu_icon(ui.painter(), rect);
                ui.add_space(8.0);
                ui.label(
                    egui::RichText::new("GPU CERT")
                        .color(tokens::CHASSIS_INK)
                        .size(15.0)
                        .strong()
                        .extra_letter_spacing(2.0),
                );
            });
            ui.add_space(10.0);

            // Chassis-level status line: always visible, always plain
            // proportional type, never phosphor — this is the app talking,
            // not a reading off the instrument.
            ui.label(
                egui::RichText::new(match self.phase {
                    Phase::ReadingGpu => "Reading GPU info",
                    Phase::Stressing => "Running stress test",
                    Phase::TestingVram => "Testing VRAM",
                    Phase::Submitting => "Submitting report",
                    Phase::Done => "Done",
                })
                .color(tokens::CHASSIS_INK_DIM)
                .size(12.0),
            );
            ui.add_space(8.0);

            // The screen: every value painted in here is a live reading,
            // phosphor monospace, nothing decorative.
            screen_frame().show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                match self.phase {
                    Phase::ReadingGpu => {
                        ui.label(phosphor_dim("awaiting device…"));
                    }
                    Phase::Stressing => {
                        if let Some(name) = &self.device_name {
                            ui.label(phosphor(format!("{name} · {} MB", self.vram_mb.unwrap_or(0))));
                        }
                        ui.add_space(4.0);
                        if let Some(sample) = &self.latest_sample {
                            ui.label(phosphor(format!(
                                "{:>3}°C   {:>4} W   {:>4} MHz core   {:>4} MHz mem",
                                sample.temperature_c,
                                sample.power_draw_mw / 1000,
                                sample.graphics_clock_mhz,
                                sample.memory_clock_mhz,
                            )));
                        } else {
                            ui.label(phosphor_dim("warming up…"));
                        }
                    }
                    Phase::TestingVram => {
                        if let Some(name) = &self.device_name {
                            ui.label(phosphor(format!("{name} · {} MB", self.vram_mb.unwrap_or(0))));
                        }
                        ui.add_space(4.0);
                        ui.label(phosphor(format!("passes {:>3}   errors {}", self.vram_passes, self.vram_errors)));
                    }
                    Phase::Submitting => {
                        ui.label(phosphor_dim("uploading…"));
                    }
                    Phase::Done => {
                        if let Some(dispatch_count) = self.stress_dispatch_count {
                            ui.label(phosphor(format!("stress: {dispatch_count} dispatches")));
                        }
                        ui.label(phosphor(format!(
                            "vram: {} passes, {} errors",
                            self.vram_passes, self.vram_errors
                        )));
                    }
                }
                if let Some(fp) = &self.fingerprint {
                    ui.add_space(4.0);
                    ui.label(phosphor_dim(format!("fp {fp}")));
                }
            });

            if self.phase == Phase::Done {
                ui.add_space(14.0);
                match &self.result {
                    Some(Ok((report_url, _badge_url, passed))) => {
                        let (text, color) = if *passed {
                            ("PASS", tokens::PASS)
                        } else {
                            ("FAIL", tokens::FAIL)
                        };
                        ui.horizontal(|ui| {
                            egui::Frame::new()
                                .fill(color)
                                .corner_radius(3.0)
                                .inner_margin(egui::Margin::symmetric(10, 4))
                                .show(ui, |ui| {
                                    ui.label(
                                        egui::RichText::new(text)
                                            .color(tokens::CHASSIS_BG)
                                            .strong()
                                            .size(15.0),
                                    );
                                });
                        });
                        ui.add_space(8.0);
                        ui.hyperlink_to("View report >", report_url);
                    }
                    Some(Err(err)) => {
                        ui.colored_label(tokens::FAIL, "Could not complete test");
                        ui.label(egui::RichText::new(err).color(tokens::CHASSIS_INK_DIM).size(11.0));
                    }
                    None => {}
                }
            }
        });
    }
}

/// Deliberately generic, not device-specific art: a rounded card body with
/// two fan hubs. Drawn with egui's painter instead of an embedded image
/// asset so there's no image file to source, license, or keep in sync with
/// icon-refresh requests — just shapes. Colored to match the chassis
/// palette rather than standing apart from it.
fn draw_gpu_icon(painter: &egui::Painter, rect: egui::Rect) {
    let card_color = tokens::CHASSIS_INK_DIM;
    let fan_color = tokens::PHOSPHOR;

    let card = egui::Rect::from_min_size(
        rect.min + egui::vec2(2.0, rect.height() * 0.15),
        egui::vec2(rect.width() - 4.0, rect.height() * 0.6),
    );
    painter.rect_filled(card, 6.0, card_color);

    let fan_radius = rect.height() * 0.13;
    let fan_y = card.center().y;
    for fan_x_frac in [0.32, 0.68] {
        let center = egui::pos2(rect.min.x + rect.width() * fan_x_frac, fan_y);
        painter.circle_filled(center, fan_radius, fan_color);
    }

    // A couple of I/O bracket notches at the bottom edge read as "this is a
    // card", not just a rounded rectangle.
    let bracket_y = rect.max.y - rect.height() * 0.08;
    for x_frac in [0.15, 0.25] {
        let x = rect.min.x + rect.width() * x_frac;
        painter.line_segment(
            [egui::pos2(x, bracket_y), egui::pos2(x, rect.max.y)],
            egui::Stroke::new(2.0, egui::Color32::from_gray(120)),
        );
    }
}
