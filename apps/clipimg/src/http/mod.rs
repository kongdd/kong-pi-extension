use std::env;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

mod client;
mod server;

pub(crate) use client::post_image;
pub(crate) use server::serve;

pub(crate) const MAX_BASE64: usize = 24 * 1024 * 1024;
pub(crate) const MAX_PNG: usize = MAX_BASE64 / 4 * 3;
const DEFAULT_HTTP_ADDR: &str = "127.0.0.1:17323";
const TIMEOUT: Duration = Duration::from_secs(10);

fn set_timeout(stream: &TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(Some(TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(TIMEOUT)))
        .map_err(|e| format!("could not set HTTP timeout: {e}"))
}

/// 监听/连接地址，默认 `127.0.0.1:17323`。
fn http_addr() -> Result<SocketAddr, String> {
    env::var("CLIPIMG_ADDR")
        .unwrap_or_else(|_| DEFAULT_HTTP_ADDR.into())
        .parse()
        .map_err(|e| format!("invalid CLIPIMG_ADDR: {e}"))
}

/// `CLIPIMG_TOKEN`；含换行则拒绝，避免注入响应头。
fn auth_token() -> Result<Option<String>, String> {
    match env::var("CLIPIMG_TOKEN") {
        Err(_) => Ok(None),
        Ok(t) if t.contains(['\r', '\n']) => Err("CLIPIMG_TOKEN contains a newline".into()),
        Ok(t) => Ok(Some(t)),
    }
}
