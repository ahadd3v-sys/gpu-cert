//! Everything the backend needs to understand a run, captured whether or not
//! the run succeeds.
//!
//! The problem this solves: diagnostics were being added one field at a time,
//! each after a specific bug had already cost a release. That only ever helps
//! with the bug you have just had. Two runs have now failed with nothing to
//! show for them, a Quadro T2000 that hung after three minutes and an RX 6600
//! that died before its first tick, and both are undiagnosable because a
//! report is only sent when a run finishes and everything else lived in a
//! console window that is now closed.
//!
//! So the rule here is that data leaves the machine early and often, never
//! only at the end:
//!
//!   - the full environment goes up with the session, before any testing
//!   - a running log goes up with every heartbeat
//!   - a failure or panic is posted before the process exits
//!   - everything is also written to a local file the user can paste
//!
//! A run that hangs at minute three still leaves the environment and the last
//! phase it reached. A run that panics leaves the panic. Neither needs anyone
//! to have kept a terminal open.

use std::sync::Mutex;
use std::time::Instant;

static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
static START: Mutex<Option<Instant>> = Mutex::new(None);

pub fn init() {
    *START.lock().unwrap() = Some(Instant::now());
}

fn elapsed_ms() -> u128 {
    START
        .lock()
        .unwrap()
        .map(|s| s.elapsed().as_millis())
        .unwrap_or(0)
}

/// Records a line and echoes it nowhere. Console output is for the person
/// watching; this is for the machine that has to explain the run later.
pub fn record(message: impl AsRef<str>) {
    let line = format!("[{:>7}ms] {}", elapsed_ms(), message.as_ref());
    if let Ok(mut log) = LOG.lock() {
        // Bounded so a long run cannot grow this without limit. The head is
        // what matters (setup, device selection, the first failure), so old
        // lines are kept and new ones dropped once full.
        if log.len() < 2000 {
            log.push(line);
        }
    }
}

/// Marks a phase boundary. These are the lines that say where a hang was,
/// which is the single most useful thing about a run that never finished.
pub fn phase(name: &str) {
    record(format!("=== {name} ==="));
}

pub fn snapshot() -> Vec<String> {
    LOG.lock().map(|l| l.clone()).unwrap_or_default()
}

/// Written on every exit path, successful or not, so there is always
/// something to paste even when the network was the thing that failed.
pub fn write_local_copy() -> Option<std::path::PathBuf> {
    let path = crate::account::config_dir()?.join("last-run.log");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    std::fs::write(&path, snapshot().join("\n")).ok()?;
    Some(path)
}
