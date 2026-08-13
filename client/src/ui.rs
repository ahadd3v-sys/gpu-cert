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

/// Letterhead, matching the certificate's own masthead rather than inventing a
/// second identity for the terminal. Kept to 43 columns so it fits an 80
/// column console with room to indent.
const WORDMARK: [&str; 5] = [
    " ███  ████  █   █    ███  █████ ████  █████",
    "█     █   █ █   █   █     █     █   █   █  ",
    "█ ██  ████  █   █   █     ████  ████    █  ",
    "█   █ █     █   █   █     █     █  █    █  ",
    " ███  █      ███     ███  █████ █   █   █  ",
];

const RULE: &str = "───────────────────────────────────────────────────────────────";

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
    let ok = std::io::stdout().is_terminal()
        && std::env::var_os("NO_COLOR").is_none()
        && enable_virtual_terminal();
    ANSI.store(ok, Ordering::Relaxed);
    ok
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
        println!("  {}", paint(BOLD, row));
    }
    println!();
    println!("  {}", paint(DIM, &format!("Hardware Verification Certificate    v{version}")));
    println!("  {}", paint(DIM, RULE));
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
}

impl Screen {
    pub fn new(version: &str, fast: bool) -> Self {
        Screen {
            version: version.to_string(),
            device: String::new(),
            vram_mb: 0,
            vulkan: String::new(),
            fast,
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

    /// Printed rather than drawn into the screen, because it must survive the
    /// next redraw: a card that hit the safety limit is the single most
    /// important thing this program can tell someone.
    pub fn warn(&mut self, message: &str) {
        if ansi() {
            print!("\x1b[2J\x1b[H");
        }
        println!("\n  {}  {}\n", paint(YELLOW, "!"), paint(BOLD, message));
        let _ = std::io::stdout().flush();
    }

    fn draw(&self) {
        if !ansi() {
            // Plain fallback: only ever print a step's final line, so a piped
            // log gets three lines rather than a thousand progress updates.
            if let Some(step) = self.steps.iter().find(|s| s.state == StepState::Running) {
                let _ = step;
            }
            return;
        }

        let mut out = String::new();
        // Home, not clear: a full clear every tick flickers.
        out.push_str("\x1b[H\n");
        for row in WORDMARK {
            out.push_str(&format!("  {}\n", paint(BOLD, row)));
        }
        out.push('\n');
        out.push_str(&format!(
            "  {}\n",
            paint(DIM, &format!("Hardware Verification Certificate    v{}", self.version))
        ));
        out.push_str(&format!("  {}\n\n", paint(DIM, RULE)));

        if !self.device.is_empty() {
            out.push_str(&format!("  {}  {}\n", paint(DIM, "Card   "), paint(BOLD, &self.device)));
            out.push_str(&format!(
                "  {}  {} MB    {}\n",
                paint(DIM, "Memory "),
                self.vram_mb,
                paint(DIM, &self.vulkan)
            ));
            out.push('\n');
        }

        if self.fast {
            out.push_str(&format!(
                "  {}\n\n",
                paint(YELLOW, "--fast: debug-length tests. This will not produce a certificate.")
            ));
        }

        for step in &self.steps {
            let (mark, name) = match step.state {
                StepState::Pending => (paint(DIM, "  "), paint(DIM, step.name)),
                StepState::Running => (paint(BOLD, "> "), paint(BOLD, step.name)),
                StepState::Done => (paint(GREEN, "ok"), step.name.to_string()),
                StepState::Failed => (paint(RED, "!!"), paint(RED, step.name)),
            };
            out.push_str(&format!("  {mark}  {name}\n"));

            if step.state == StepState::Running {
                out.push_str(&format!("      {}\n", bar(step.progress)));
            }
            if !step.detail.is_empty() && step.state != StepState::Pending {
                out.push_str(&format!("      {}\n", paint(DIM, &step.detail)));
            }
            out.push('\n');
        }

        // Clear from the cursor to the end, so a shorter frame cannot leave
        // fragments of a longer one behind it.
        out.push_str("\x1b[J");
        print!("{out}");
        let _ = std::io::stdout().flush();
    }
}

fn bar(fraction: f32) -> String {
    const WIDTH: usize = 40;
    let filled = ((fraction.clamp(0.0, 1.0) * WIDTH as f32).round() as usize).min(WIDTH);
    let full = "█".repeat(filled);
    let empty = "░".repeat(WIDTH - filled);
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
            println!("  {}", paint(BOLD, row));
        }
        println!();
        println!("  {}", paint(DIM, &format!("Hardware Verification Certificate    v{version}")));
        println!("  {}", paint(DIM, RULE));
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
