//! Optional account link, modelled on how Geekbench handles this: the tool is
//! fully usable with no account, results are public either way, and connecting
//! an account is a separate step you can take before or after a run.
//!
//! Concretely there are three paths, and none of them is a prerequisite for
//! another:
//!
//!   1. Run it, never sign up. The certificate is public at its URL.
//!   2. Run it, then claim that certificate to an account from its own page.
//!   3. Paste an upload key in here once; every run after that files itself.
//!
//! The key is stored in plain text next to the exe's config dir. It authorizes
//! exactly one thing — "attribute a report to this account" — and cannot read
//! anything back out, so it's treated as a convenience token rather than a
//! password. The dashboard can replace it at any time, which is the revocation
//! story for a machine that's been sold or lost.

use std::io::Write;
use std::path::PathBuf;

const KEY_PREFIX: &str = "GPUC-";
/// `GPUC-` + 4 groups of 4 + 3 separators.
const KEY_LEN: usize = 5 + 16 + 3;

/// `%APPDATA%\gpu-cert\upload-key` on Windows, `~/.config/gpu-cert/upload-key`
/// elsewhere (dev boxes). Returns `None` if neither variable is set, in which
/// case the key just isn't persisted and the run behaves like an anonymous one.
fn key_path() -> Option<PathBuf> {
    let dir = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }?;
    Some(dir.join("gpu-cert").join("upload-key"))
}

/// Accepts the key in whatever shape it gets pasted: extra spaces, lowercase,
/// or with the dashes dropped. Anything that isn't recoverable returns `None`
/// so the caller can re-prompt instead of sending a malformed key.
pub fn normalize(input: &str) -> Option<String> {
    let compact: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();

    let body = compact.strip_prefix("GPUC").unwrap_or(&compact);
    if body.len() != 16 {
        return None;
    }

    let groups: Vec<String> = body
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect();
    Some(format!("{KEY_PREFIX}{}", groups.join("-")))
}

pub fn load() -> Option<String> {
    let contents = std::fs::read_to_string(key_path()?).ok()?;
    normalize(&contents)
}

pub fn save(key: &str) -> std::io::Result<()> {
    let Some(path) = key_path() else {
        return Ok(()); // Nowhere to persist it; not worth failing the run over.
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, key)
}

pub fn forget() -> std::io::Result<()> {
    let Some(path) = key_path() else { return Ok(()) };
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Asked once, before the tests start rather than after — a 16-minute run that
/// then blocks on a question the user walked away from would file itself
/// anonymously by default, which is the outcome the prompt exists to avoid.
///
/// Enter with nothing typed is a first-class answer: it runs anonymously.
pub fn prompt_for_key() -> Option<String> {
    if let Some(existing) = load() {
        println!("Filing to the account connected to this machine.");
        println!("  key: {existing}   (run with --forget-account to stop)");
        return Some(existing);
    }

    println!();
    println!("Connect an account? (optional)");
    println!("  An account collects your certificates in one place. Without one,");
    println!("  the certificate is still public at its own URL, and you can add it");
    println!("  to an account later from that page.");
    println!();
    println!("  Paste your upload key from the dashboard, or press Enter to skip:");
    print!("  > ");
    let _ = std::io::stdout().flush();

    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return None;
    }
    if line.trim().is_empty() {
        println!("  Running without an account.");
        return None;
    }

    match normalize(&line) {
        Some(key) => {
            if let Err(e) = save(&key) {
                // Not fatal: this run can still be attributed, it just won't be
                // remembered for the next one.
                println!("  Could not save the key for next time: {e}");
            }
            println!("  Connected. Reports from this machine will file to that account.");
            Some(key)
        }
        None => {
            println!(
                "  That doesn't look like an upload key (expected {KEY_LEN} characters, like {KEY_PREFIX}A1B2-C3D4-E5F6-G7H8)."
            );
            println!("  Running without an account. You can add this certificate to an account later.");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn accepts_the_canonical_form() {
        assert_eq!(
            normalize("GPUC-9XJ2-X8PU-6L99-3N2J").as_deref(),
            Some("GPUC-9XJ2-X8PU-6L99-3N2J")
        );
    }

    #[test]
    fn repairs_pasted_variants() {
        for input in [
            "  gpuc-9xj2-x8pu-6l99-3n2j\n",
            "GPUC9XJ2X8PU6L993N2J",
            "9XJ2-X8PU-6L99-3N2J",
        ] {
            assert_eq!(
                normalize(input).as_deref(),
                Some("GPUC-9XJ2-X8PU-6L99-3N2J"),
                "failed on {input:?}"
            );
        }
    }

    #[test]
    fn rejects_wrong_length() {
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("GPUC-9XJ2"), None);
        assert_eq!(normalize("GPUC-9XJ2-X8PU-6L99-3N2J-EXTRA"), None);
    }
}
