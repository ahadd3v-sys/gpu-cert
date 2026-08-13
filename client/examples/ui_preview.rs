//! Renders the console the way a real run does, so the layout can be checked
//! without a GPU. `cargo run --example ui_preview`.
#![allow(dead_code)]
#[path = "../src/ui.rs"]
mod ui;

fn main() {
    ui::init();
    ui::banner(env!("CARGO_PKG_VERSION"));
    let mut screen = ui::Screen::new(env!("CARGO_PKG_VERSION"), false);
    screen.set_device("AMD Radeon RX 6600", 8176, "AMD Radeon RX 6600");
    screen.finish(0, "15739 dispatches, peak 66\u{b0}C");
    screen.start(1, "allocating");
    screen.update(1, 0.38, "pass 812, 0 errors");
    screen.finish(1, "6878 passes, 6787 MB (83%), 0 errors");
    screen.start(2, "comparing every pixel of every frame");
    screen.update(2, 0.62, "comparing every pixel of every frame");
    ui::result(
        env!("CARGO_PKG_VERSION"),
        Some(true),
        "AMD Radeon RX 6600 passed every test",
        &[
            ("Coverage", "83% of VRAM, 0 errors".to_string()),
            ("Report", "https://gpucert.com/r/fbe4ebfd".to_string()),
            ("Badge", "https://gpucert.com/r/fbe4ebfd/badge".to_string()),
            ("Account", "not attached. Add it from the report page.".to_string()),
        ],
    );
}
