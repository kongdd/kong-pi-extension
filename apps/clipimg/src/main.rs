use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};

mod clipboard;

use clipboard::clipboard_png;

const MAX_PNG: usize = 18 * 1024 * 1024;

enum Target {
    Stdout,
    File(OsString),
}

fn main() {
    if let Err(error) = run() {
        eprintln!("clipimg: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let target = target(env::args_os().skip(1))?;
    let png = clipboard_png()?;
    if png.len() > MAX_PNG {
        return Err("clipboard image exceeds the 18 MB limit".into());
    }
    match target {
        Target::Stdout => io::stdout().write_all(&png),
        Target::File(path) => fs::write(path, png),
    }
    .map_err(|e| format!("could not write PNG: {e}"))
}

fn target(mut args: impl Iterator<Item = OsString>) -> Result<Target, String> {
    match (args.next(), args.next(), args.next()) {
        (Some(flag), None, None) if flag == "--stdout" => Ok(Target::Stdout),
        (Some(flag), Some(path), None) if flag == "--output" => Ok(Target::File(path)),
        _ => Err("usage: clipimg --stdout | clipimg --output PATH".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_targets() {
        assert!(matches!(
            target(["--stdout".into()].into_iter()),
            Ok(Target::Stdout)
        ));
        assert!(matches!(
            target(["--output".into(), "shot.png".into()].into_iter()),
            Ok(Target::File(path)) if path == "shot.png"
        ));
    }
}
