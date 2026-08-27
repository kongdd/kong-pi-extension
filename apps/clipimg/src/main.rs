use std::env;

mod cli;
mod clipboard;
mod http;
mod wezterm;

use cli::{Target, target};
use clipboard::clipboard_png;
use http::{MAX_PNG, post_image, serve};
use wezterm::{ATTACH, FAILED, SAVING, signal};

fn main() {
    if let Err(error) = run() {
        eprintln!("clipimg: {error}");
        std::process::exit(1);
    }
}

/// 图片走 HTTP，私有控制信号只通知扩展，不提交编辑器内容。
fn run() -> Result<(), String> {
    match target(env::args().skip(1))? {
        Target::Serve => serve(),
        Target::Http => post_image(&load_png()?),
        Target::WezTerm(pane) => {
            let png = load_png()?;
            signal(&pane, SAVING)?;
            post_image(&png)
                .and_then(|_| signal(&pane, ATTACH))
                .map_err(|error| {
                    let _ = signal(&pane, FAILED);
                    error
                })
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
