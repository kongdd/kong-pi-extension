use std::env;

use base64::{Engine, engine::general_purpose::STANDARD};

mod cli;
mod clipboard;
mod http;
mod wezterm;

use cli::{Target, target};
use clipboard::clipboard_png;
use http::{MAX_BASE64, MAX_PNG, post_image, serve};
use wezterm::submit;

fn main() {
    if let Err(error) = run() {
        eprintln!("clipimg: {error}");
        std::process::exit(1);
    }
}

/// 优先走 HTTP；失败则把 PNG base64 塞进 `/clipimg` 命令。
fn run() -> Result<(), String> {
    match target(env::args().skip(1))? {
        Target::Serve => serve(),
        Target::Http => post_image(&load_png()?),
        Target::WezTerm(pane) => {
            let png = load_png()?;
            if post_image(&png).is_ok() {
                return submit(&pane, b"/clipimg");
            }
            let encoded = STANDARD.encode(&png);
            if encoded.len() > MAX_BASE64 {
                return Err("clipboard image exceeds the 24 MB limit".into());
            }
            submit(&pane, format!("/clipimg {encoded}").as_bytes())
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
