//! Renders the console the way a real run does, so the layout can be checked
//! without a GPU. `cargo run --example ui_preview`.
#![allow(dead_code)]
#[path = "../src/ui.rs"]
mod ui;

fn main() {
    ui::init();
    let mut screen = ui::Screen::new(env!("CARGO_PKG_VERSION"), false);
    screen.set_device("AMD Radeon RX 6600", 8176, "Vulkan: AMD Radeon RX 6600");
    screen.finish(0, "15739 dispatches, peak 66\u{b0}C");
    screen.finish(1, "6878 passes over 6787 MB (83% of the card), 0 errors");
    screen.start(2, "comparing every pixel of every frame");
    screen.update(2, 0.62, "comparing every pixel of every frame");
    println!("\n\n--- final screen ---\n");
    ui::result(
        env!("CARGO_PKG_VERSION"),
        true,
        "AMD Radeon RX 6600 passed every test",
        &[
            ("Coverage", "83% of VRAM, 0 errors".to_string()),
            ("Report", "https://gpucert.com/r/fbe4ebfd-422a-4e7f-92e8".to_string()),
            ("Badge", "https://gpucert.com/r/fbe4ebfd-422a-4e7f-92e8/badge".to_string()),
            ("Account", "not attached. You can attach it from the report page.".to_string()),
        ],
    );
}
