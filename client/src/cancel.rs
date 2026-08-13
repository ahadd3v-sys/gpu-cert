//! Makes a cancelled run say so instead of vanishing.
//!
//! A session opened on 2026-08-13 was never consumed and never reported a
//! failure. Nothing in the database could distinguish "the user pressed Ctrl+C"
//! from "the client died silently", and those need very different responses:
//! one is nothing, the other is a bug.
//!
//! Closing the console window, logging off and shutting down all land here too,
//! not just Ctrl+C, which matters because closing the window is the most likely
//! way someone abandons a sixteen minute run.
//!
//! Windows gives a control handler a few seconds before terminating the process
//! anyway, so everything here is on a short leash and the exit is explicit
//! rather than left to the handler returning.

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{BOOL, FALSE, TRUE};
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT,
        CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
    };

    unsafe extern "system" fn handler(event: u32) -> BOOL {
        let reason = match event {
            CTRL_C_EVENT => "cancelled by the user (Ctrl+C)",
            CTRL_BREAK_EVENT => "cancelled by the user (Ctrl+Break)",
            CTRL_CLOSE_EVENT => "the console window was closed during the run",
            CTRL_LOGOFF_EVENT => "the user logged off during the run",
            CTRL_SHUTDOWN_EVENT => "the machine shut down during the run",
            _ => return FALSE,
        };

        crate::report_cancelled(reason);

        // Exiting here rather than returning TRUE, which would let the run
        // carry on with the card under load and nobody watching it.
        std::process::exit(130);
    }

    pub fn install() {
        unsafe {
            // A failure to install is not worth failing the run over. It costs
            // the diagnosis of a cancelled run, not the run itself.
            let _ = SetConsoleCtrlHandler(Some(handler), TRUE);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn install() {}
}

pub use imp::install;
