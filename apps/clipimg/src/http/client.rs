use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use super::{auth_token, http_addr, set_timeout};

/// POST `/image`，成功须返回 204。
pub(crate) fn post_image(png: &[u8]) -> Result<(), String> {
    let addr = http_addr()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|e| format!("could not connect to clipimg HTTP receiver: {e}"))?;
    set_timeout(&stream)?;

    let token = auth_token()?
        .map(|t| format!("X-Clipimg-Token: {t}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "POST /image HTTP/1.1\r\nHost: {addr}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n{token}\r\n",
        png.len()
    )
    .and_then(|()| stream.write_all(png))
    .map_err(|e| format!("could not send image: {e}"))?;

    let mut response = String::new();
    stream
        .take(64 * 1024)
        .read_to_string(&mut response)
        .map_err(|e| format!("could not read HTTP response: {e}"))?;
    if response.split_whitespace().nth(1) == Some("204") {
        return Ok(());
    }
    let status = response.lines().next().unwrap_or_default();
    let body = response
        .split_once("\r\n\r\n")
        .map_or("", |(_, b)| b.trim());
    Err(if body.is_empty() {
        format!("clipimg HTTP receiver returned {status}")
    } else {
        format!("clipimg HTTP receiver returned {status}: {body}")
    })
}
