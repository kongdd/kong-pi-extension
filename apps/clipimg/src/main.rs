use std::env;
use std::io::{self, Write};

use base64::{Engine, engine::general_purpose::STANDARD};

mod cli;
mod clipboard;
mod http;
mod wezterm;

use cli::{Target, target};
use clipboard::clipboard_png;
use http::{MAX_BASE64, MAX_PNG, post_image, serve};
use wezterm::send_image;

fn main() {
    if let Err(error) = run() {
        eprintln!("clipimg: {error}");
        std::process::exit(1);
    }
}

/// 默认把 PNG base64 通过私有帧发送给扩展；HTTP 仅由 `--http` 显式使用。
fn run() -> Result<(), String> {
    match target(env::args().skip(1))? {
        Target::Serve => serve(),
        Target::Http => post_image(&load_png()?),
        Target::Stdout => io::stdout()
            .write_all(&load_png()?)
            .map_err(|e| format!("could not write PNG: {e}")),
        Target::WezTerm(pane) => {
            let png = load_png()?;
            let encoded = STANDARD.encode(&png);
            if encoded.len() > MAX_BASE64 {
                return Err("clipboard image exceeds the 24 MB limit".into());
            }
            send_image(&pane, &encoded)
        }
    }
}

fn load_png() -> Result<Vec<u8>, String> {
    let png = clipboard_png()?;
    if png.len() > MAX_PNG {
        return Err("clipboard image exceeds the 18 MB limit".into());
    }
    Ok(png)
}
