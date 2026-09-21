use std::env;
use std::io::{self, Write};

mod clipboard;

use clipboard::clipboard_png;

const MAX_PNG: usize = 18 * 1024 * 1024;

fn main() {
    if let Err(error) = run() {
        eprintln!("clipimg: {error}");
        std::process::exit(1);
    }
}

/// 把剪贴板图像输出为 PNG。
fn run() -> Result<(), String> {
    if env::args().skip(1).collect::<Vec<_>>() != ["--stdout"] {
        return Err("usage: clipimg --stdout".into());
    }
    io::stdout()
        .write_all(&load_png()?)
        .map_err(|e| format!("could not write PNG: {e}"))
}

fn load_png() -> Result<Vec<u8>, String> {
    let png = clipboard_png()?;
    if png.len() > MAX_PNG {
        return Err("clipboard image exceeds the 18 MB limit".into());
    }
    Ok(png)
}
