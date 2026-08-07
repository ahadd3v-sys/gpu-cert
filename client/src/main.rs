mod adl;
mod fingerprint;
mod gui;
mod nvml;
mod report;
mod vulkan;

use std::sync::mpsc;

fn main() -> eframe::Result<()> {
    let (tx, rx) = mpsc::channel();

    // The pipeline (NVML read, multi-minute Vulkan stress/VRAM dispatches,
    // network submit) runs on its own thread — eframe's event loop owns the
    // main thread and would freeze the window for the whole test duration
    // otherwise. gui::GpuCertApp polls `rx` every frame to stay current.
    std::thread::spawn(move || gui::run_pipeline(tx));

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([420.0, 360.0]),
        ..Default::default()
    };

    eframe::run_native(
        "GPU Cert",
        options,
        Box::new(|cc| Ok(Box::new(gui::GpuCertApp::new(cc, rx)))),
    )
}
