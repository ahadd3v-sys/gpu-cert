//! The console the seller actually looks at for sixteen minutes.
//!
//! This used to be a stream of `println!`s: every phase, every value, every
//! transient detail, scrolling past and accumulating. That made sense when the
//! console was the only record of a run and anything not printed was lost.
//!
//! It is not the only record any more. `diag.rs` sends the environment, the
//! full log and any failure to the backend, and writes a local copy on every
//! exit path, so the console no longer has to double as a diagnostic dump. It
//! can be what it should have been from the start: one screen that says what
//! card is being tested, what is happening to it right now, and how far along
//! it is.
//!
//! So the screen is redrawn in place rather than appended to. Redraw moves the
//! cursor home and clears to the end rather than clearing the whole screen
//! first, because a full clear once a second flickers badly on Windows
//! consoles.
//!
//! Everything degrades to plain text. If the terminal will not accept ANSI
//! sequences, or output is being piped to a file, or NO_COLOR is set, the same
//! information is printed as ordinary lines. Nobody should lose the report URL
//! because their console is old.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};

static ANSI: AtomicBool = AtomicBool::new(false);
static UNICODE: AtomicBool = AtomicBool::new(false);

/// Letterhead, matching the certificate's own masthead rather than inventing a
/// second identity for the terminal. Kept to 43 columns so it fits an 80
/// column console with room to indent.
///
/// Stored as ASCII and filled in at render time. The exe writes UTF-8, and a
/// console whose output codepage is not UTF-8 renders every box-drawing
/// character as two bytes of mojibake, which is a worse first impression than
/// plain hashes. See `init`.
const WORDMARK: [&str; 5] = [
    " ###  ####  #   #    ###  ##### ####  #####",
    "#     #   # #   #   #     #     #   #   #  ",
    "# ##  ####  #   #   #     ####  ####    #  ",
    "#   # #     #   #   #     #     #  #    #  ",
    " ###  #      ###     ###  ##### #   #   #  ",
];

fn wordmark_row(row: &str) -> String {
    if unicode() {
        row.replace('#', "\u{2588}")
    } else {
        row.to_string()
    }
}

/// The degree sign is also UTF-8, so it needs the same treatment as the box
/// drawing: on a console that refused UTF-8 it would arrive as two stray
/// bytes in the middle of a temperature.
pub fn degree() -> &'static str {
    if unicode() { "\u{b0}" } else { " " }
}

fn rule() -> String {
    let ch = if unicode() { "\u{2500}" } else { "-" };
    ch.repeat(43)
}

/// Erase from the cursor to the end of the line.
///
/// Every drawn line ends with this. Without it a frame only overwrites the
/// columns it actually uses, so anything longer printed earlier survives to
/// the right of it: a real run showed "Card  AMD Radeon RX 6600" with the tail
/// of an unrelated diagnostic line still attached to it.
const EOL: &str = "\x1b[K";

// Deliberately few. The certificate is ink on paper with one accent; the
// console should not be a different product.
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const YELLOW: &str = "\x1b[33m";

/// Turns on ANSI handling and reports whether the screen can be redrawn in
/// place. Everything below checks this, so a `false` here is a complete
/// fallback to plain scrolling output rather than a half-broken screen.
pub fn init() -> bool {
    // Asked for before anything is drawn, and the answer is believed. A
    // console left on codepage 437 will render every block and box-drawing
    // character as mojibake, and a screen full of garbage is a worse first
    // impression than one made of hashes and dashes.
    UNICODE.store(enable_utf8_output(), Ordering::Relaxed);

    let ok = std::io::stdout().is_terminal()
        && std::env::var_os("NO_COLOR").is_none()
        && enable_virtual_terminal();
    ANSI.store(ok, Ordering::Relaxed);
    ok
}

fn unicode() -> bool {
    UNICODE.load(Ordering::Relaxed)
}

/// Windows consoles default to an OEM codepage, not UTF-8, and this program
/// writes UTF-8. Setting it is the difference between a letterhead and a wall
/// of question marks on a machine nobody here has ever seen.
#[cfg(windows)]
fn enable_utf8_output() -> bool {
    use windows_sys::Win32::Globalization::CP_UTF8;
    use windows_sys::Win32::System::Console::{GetConsoleOutputCP, SetConsoleOutputCP};
    unsafe {
        if GetConsoleOutputCP() == CP_UTF8 {
            return true;
        }
        SetConsoleOutputCP(CP_UTF8) != 0
    }
}

#[cfg(not(windows))]
fn enable_utf8_output() -> bool {
    // Every terminal this runs on outside Windows is UTF-8, but honour an
    // explicit non-UTF-8 locale rather than assuming.
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_CTYPE"))
        .or_else(|_| std::env::var("LANG"))
        .map(|v| v.to_ascii_uppercase().contains("UTF"))
        .unwrap_or(true)
}

fn ansi() -> bool {
    ANSI.load(Ordering::Relaxed)
}

/// Windows consoles do not interpret ANSI escapes until asked to, and the ask
/// can fail on older builds. Called through GetStdHandle rather than assuming
/// a handle value, and a failure here is reported honestly so the caller falls
/// back to plain text instead of printing escape codes at someone.
#[cfg(windows)]
fn enable_virtual_terminal() -> bool {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        STD_OUTPUT_HANDLE,
    };
    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle.is_null() {
            return false;
        }
        let mut mode = 0u32;
        if GetConsoleMode(handle, &mut mode) == 0 {
            return false;
        }
        if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
            return true;
        }
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0
    }
}

#[cfg(not(windows))]
fn enable_virtual_terminal() -> bool {
    true
}

fn paint(color: &str, text: &str) -> String {
    if ansi() {
        format!("{color}{text}{RESET}")
    } else {
        text.to_string()
    }
}

pub fn banner(version: &str) {
    if !ansi() {
        println!("gpu-cert v{version}, hardware verification client");
        return;
    }
    print!("\x1b[2J\x1b[H");
    println!();
    for row in WORDMARK {
        println!("  {}", paint(BOLD, &wordmark_row(row)));
    }
    println!();
    println!("  {}", paint(DIM, &format!("Hardware Verification Certificate    v{version}")));
    println!("  {}", paint(DIM, &rule()));
    let _ = std::io::stdout().flush();
}

#[derive(Clone, Copy, PartialEq)]
pub enum StepState {
    Pending,
    Running,
    Done,
    Failed,
}

pub struct Step {
    pub name: &'static str,
    pub state: StepState,
    /// One line of result once finished, or live figures while running.
    pub detail: String,
    /// 0.0 to 1.0, drawn as a bar while running.
    pub progress: f32,
}

/// The whole console, redrawn in place. Holding the state here rather than
/// printing as things happen is what makes "no useless detail" achievable:
/// a value that is superseded is overwritten instead of scrolled past.
pub struct Screen {
    version: String,
    device: String,
    vram_mb: u64,
    vulkan: String,
    fast: bool,
    steps: Vec<Step>,
    first_draw: bool,
    notice: Option<String>,
}

impl Screen {
    pub fn new(version: &str, fast: bool) -> Self {
        Screen {
            version: version.to_string(),
            device: String::new(),
            vram_mb: 0,
            vulkan: String::new(),
            fast,
            first_draw: true,
            notice: None,
            steps: vec![
                Step { name: "Stress test", state: StepState::Pending, detail: String::new(), progress: 0.0 },
                Step { name: "VRAM pattern test", state: StepState::Pending, detail: String::new(), progress: 0.0 },
                Step { name: "Render integrity test", state: StepState::Pending, detail: String::new(), progress: 0.0 },
            ],
        }
    }

    pub fn set_device(&mut self, device: &str, vram_mb: u64, vulkan: &str) {
        self.device = device.to_string();
        self.vram_mb = vram_mb;
        self.vulkan = vulkan.to_string();
    }

    pub fn start(&mut self, index: usize, detail: &str) {
        if let Some(step) = self.steps.get_mut(index) {
            step.state = StepState::Running;
            step.detail = detail.to_string();
            step.progress = 0.0;
        }
        self.draw();
    }

    pub fn update(&mut self, index: usize, progress: f32, detail: &str) {
        if let Some(step) = self.steps.get_mut(index) {
            step.progress = progress.clamp(0.0, 1.0);
            step.detail = detail.to_string();
        }
        self.draw();
    }

    pub fn finish(&mut self, index: usize, detail: &str) {
        if let Some(step) = self.steps.get_mut(index) {
            step.state = StepState::Done;
            step.detail = detail.to_string();
            step.progress = 1.0;
        }
        self.draw();
    }

    pub fn fail(&mut self, index: usize, detail: &str) {
        if let Some(step) = self.steps.get_mut(index) {
            step.state = StepState::Failed;
            step.detail = detail.to_string();
        }
        self.draw();
    }

    /// Held in the frame rather than printed alongside it. Printing would put
    /// it outside the redrawn region, where the next frame a second later
    /// wipes it, and a card that hit the safety limit is the single most
    /// important thing this program can say.
    pub fn notice(&mut self, message: &str) {
        self.notice = Some(message.to_string());
        self.draw();
    }

    fn draw(&mut self) {
        if !ansi() {
            return;
        }

        let mut out = String::new();
        // The first frame clears everything above it: the banner, the account
        // prompt, and anything a driver printed on its way up. Later frames
        // only home the cursor, because a full clear every tick flickers
        // badly on Windows consoles.
        if self.first_draw {
            out.push_str("\x1b[2J");
            self.first_draw = false;
        }
        out.push_str("\x1b[H");

        let line = |out: &mut String, text: &str| {
            out.push_str(text);
            out.push_str(EOL);
            out.push('\n');
        };

        line(&mut out, "");
        for row in WORDMARK {
            line(&mut out, &format!("  {}", paint(BOLD, &wordmark_row(row))));
        }
        line(&mut out, "");
        line(
            &mut out,
            &format!(
                "  {}",
                paint(DIM, &format!("Hardware Verification Certificate    v{}", self.version))
            ),
        );
        line(&mut out, &format!("  {}", paint(DIM, &rule())));

        if !self.device.is_empty() {
            // The Vulkan device name is only shown when it differs from what
            // the vendor telemetry reported. Identical is the normal case and
            // printing the same string twice is noise; different is worth
            // seeing, because it is the disagreement device selection exists
            // to catch.
            let extra = if self.vulkan.is_empty() || self.vulkan == self.device {
                format!(", {} MB", self.vram_mb)
            } else {
                format!(", {} MB, Vulkan reports {}", self.vram_mb, self.vulkan)
            };
            line(&mut out, &format!("  {}{}", paint(BOLD, &self.device), paint(DIM, &extra)));
        }
        line(&mut out, "");

        if self.fast {
            line(
                &mut out,
                &format!("  {}", paint(YELLOW, "--fast: debug run, this will not produce a certificate")),
            );
            line(&mut out, "");
        }

        if let Some(notice) = &self.notice {
            line(&mut out, &format!("  {}  {}", paint(YELLOW, "!"), paint(BOLD, notice)));
            line(&mut out, "");
        }

        for step in &self.steps {
            match step.state {
                // Finished steps collapse to one line. The result is the only
                // part still worth space.
                StepState::Done => line(
                    &mut out,
                    &format!("  {}  {:<22} {}", paint(GREEN, "ok"), step.name, paint(DIM, &step.detail)),
                ),
                StepState::Failed => {
                    line(&mut out, &format!("  {}  {}", paint(RED, "!!"), paint(RED, step.name)));
                    line(&mut out, &format!("      {}", paint(RED, &step.detail)));
                }
                StepState::Pending => {
                    line(&mut out, &format!("  {}  {}", paint(DIM, ".."), paint(DIM, step.name)))
                }
                StepState::Running => {
                    line(&mut out, &format!("  {}  {}", paint(BOLD, ">>"), paint(BOLD, step.name)));
                    line(&mut out, &format!("      {}", bar(step.progress)));
                    if !step.detail.is_empty() {
                        line(&mut out, &format!("      {}", paint(DIM, &step.detail)));
                    }
                }
            }
        }

        // Clears any rows a taller previous frame left below this one.
        out.push_str("\x1b[J");
        print!("{out}");
        let _ = std::io::stdout().flush();
    }
}

fn bar(fraction: f32) -> String {
    const WIDTH: usize = 40;
    let filled = ((fraction.clamp(0.0, 1.0) * WIDTH as f32).round() as usize).min(WIDTH);
    let (fill, blank) = if unicode() { ("\u{2588}", "\u{2591}") } else { ("#", ".") };
    let full = fill.repeat(filled);
    let empty = blank.repeat(WIDTH - filled);
    if ansi() {
        format!("{full}{DIM}{empty}{RESET}  {:>3}%", (fraction.clamp(0.0, 1.0) * 100.0) as u32)
    } else {
        format!("{full}{empty}  {:>3}%", (fraction.clamp(0.0, 1.0) * 100.0) as u32)
    }
}

/// The last thing anyone sees. Drawn fresh rather than appended, because the
/// only things that matter at this point are the verdict and the link.
pub fn result(version: &str, verdict_pass: bool, headline: &str, lines: &[(&str, String)]) {
    if ansi() {
        print!("\x1b[2J\x1b[H");
    }
    println!();
    if ansi() {
        for row in WORDMARK {
            println!("  {}", paint(BOLD, &wordmark_row(row)));
        }
        println!();
        println!("  {}", paint(DIM, &format!("Hardware Verification Certificate    v{version}")));
        println!("  {}", paint(DIM, &rule()));
        println!();
    }

    let stamp = if verdict_pass {
        paint(GREEN, "  PASS  ")
    } else {
        paint(RED, "  FAIL  ")
    };
    println!("  {} {}", paint(BOLD, &stamp), paint(BOLD, headline));
    println!();
    for (label, value) in lines {
        println!("  {}  {}", paint(DIM, &format!("{label:<9}")), value);
    }
    println!();
    let _ = std::io::stdout().flush();
}
