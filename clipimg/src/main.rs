use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::time::Duration;

use arboard::Clipboard;
use base64::{Engine, engine::general_purpose::STANDARD};
use png::{BitDepth, ColorType, Compression, Encoder};

const MAX_BASE64: usize = 24 * 1024 * 1024;
const MAX_PNG: usize = MAX_BASE64 / 4 * 3;
const DEFAULT_HTTP_ADDR: &str = "127.0.0.1:17323";

fn main() {
    if let Err(error) = run() {
        eprintln!("clipimg: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match target(env::args().skip(1))? {
        Target::WezTerm(pane) => {
            submit(&pane, b"/clipimg saving")?;

            let encoded = STANDARD.encode(clipboard_png()?);
            if encoded.len() > MAX_BASE64 {
                return Err("clipboard image exceeds the 24 MB limit".into());
            }
            submit(&pane, format!("/clipimg {encoded}").as_bytes())
        }
        Target::Http => {
            let png = clipboard_png()?;
            if png.len() > MAX_PNG {
                return Err("clipboard image exceeds the 18 MB limit".into());
            }
            post_image(&png)
        }
    }
}

enum Target {
    WezTerm(String),
    Http,
}

fn target(mut args: impl Iterator<Item = String>) -> Result<Target, String> {
    let target = args.next().ok_or_else(usage)?;
    if args.next().is_some() {
        return Err(usage());
    }
    if target == "--http" {
        return Ok(Target::Http);
    }
    if target.parse::<u64>().is_ok() {
        return Ok(Target::WezTerm(target));
    }
    Err(usage())
}

fn usage() -> String {
    "usage: clipimg PANE_ID | clipimg --http".into()
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

fn post_image(png: &[u8]) -> Result<(), String> {
    let http_addr = env::var("CLIPIMG_ADDR").unwrap_or_else(|_| DEFAULT_HTTP_ADDR.into());
    let addr: SocketAddr = http_addr
        .parse()
        .map_err(|error| format!("invalid CLIPIMG_ADDR: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|error| format!("could not connect to clipimg HTTP receiver: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("could not set HTTP timeout: {error}"))?;

    let token = env::var("CLIPIMG_TOKEN").ok();
    if token
        .as_deref()
        .is_some_and(|value| value.contains(['\r', '\n']))
    {
        return Err("CLIPIMG_TOKEN contains a newline".into());
    }
    let token_header = token
        .map(|value| format!("X-Clipimg-Token: {value}\r\n"))
        .unwrap_or_default();
    let header = format!(
        "POST /image HTTP/1.1\r\nHost: {http_addr}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n{token_header}\r\n",
        png.len()
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|()| stream.write_all(png))
        .map_err(|error| format!("could not send image: {error}"))?;

    let mut response = String::new();
    stream
        .take(64 * 1024)
        .read_to_string(&mut response)
        .map_err(|error| format!("could not read HTTP response: {error}"))?;
    let status = response.lines().next().unwrap_or_default();
    if status.split_whitespace().nth(1) == Some("204") {
        return Ok(());
    }
    let body = response
        .split_once("\r\n\r\n")
        .map_or("", |(_, body)| body.trim());
    Err(if body.is_empty() {
        format!("clipimg HTTP receiver returned {status}")
    } else {
        format!("clipimg HTTP receiver returned {status}: {body}")
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_and_wezterm_targets() {
        assert!(matches!(
            target(["--http".into()].into_iter()),
            Ok(Target::Http)
        ));
        assert!(matches!(
            target(["42".into()].into_iter()),
            Ok(Target::WezTerm(pane)) if pane == "42"
        ));
        assert!(target(["bad".into()].into_iter()).is_err());
    }
}
