use std::env;
use std::io::Write;
use std::process::{Command, Stdio};

use arboard::Clipboard;
use base64::{Engine, engine::general_purpose::STANDARD};
use png::{BitDepth, ColorType, Compression, Encoder};

const MAX_BASE64: usize = 24 * 1024 * 1024;

fn main() {
    if let Err(error) = run() {
        eprintln!("clipimg: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let pane = pane_id()?;
    submit(&pane, b"/clipimg saving")?;

    let encoded = STANDARD.encode(clipboard_png()?);
    if encoded.len() > MAX_BASE64 {
        return Err("clipboard image exceeds the 24 MB limit".into());
    }

    submit(&pane, format!("/clipimg {encoded}").as_bytes())
}

fn pane_id() -> Result<String, String> {
    let mut args = env::args().skip(1);
    let pane = args.next().ok_or_else(usage)?;

    if args.next().is_some() || pane.parse::<u64>().is_err() {
        return Err(usage());
    }
    Ok(pane)
}

fn usage() -> String {
    "usage: clipimg PANE_ID".into()
}

fn clipboard_png() -> Result<Vec<u8>, String> {
    let mut clipboard =
        Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
    let image = clipboard
        .get_image()
        .map_err(|error| format!("clipboard does not contain an image: {error}"))?;
    let width = u32::try_from(image.width).map_err(|_| "clipboard image is too wide")?;
    let height = u32::try_from(image.height).map_err(|_| "clipboard image is too tall")?;

    let mut output = Vec::with_capacity(image.bytes.len());
    let mut encoder = Encoder::new(&mut output, width, height);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_compression(Compression::Fast);
    encoder
        .write_header()
        .and_then(|mut writer| writer.write_image_data(image.bytes.as_ref()))
        .map_err(|error| format!("PNG encoding failed: {error}"))?;
    Ok(output)
}

fn submit(pane: &str, input: &[u8]) -> Result<(), String> {
    send(pane, input, false)?;
    send(pane, b"\r", true)
}

fn send(pane: &str, input: &[u8], raw: bool) -> Result<(), String> {
    let mut command = Command::new("wezterm.exe");
    command.args(["cli", "send-text", "--pane-id", pane]);
    if raw {
        command.arg("--no-paste");
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("could not start wezterm.exe: {error}"))?;

    let mut stdin = child.stdin.take().ok_or("could not open wezterm stdin")?;
    stdin
        .write_all(input)
        .map_err(|error| format!("could not write to wezterm: {error}"))?;
    drop(stdin);

    let status = child
        .wait()
        .map_err(|error| format!("could not wait for wezterm.exe: {error}"))?;
    if !status.success() {
        return Err(format!("wezterm.exe exited with {status}"));
    }
    Ok(())
}
