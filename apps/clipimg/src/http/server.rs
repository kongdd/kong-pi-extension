use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

use super::{MAX_PNG, auth_token, http_addr, set_timeout};

/// 单槽收件箱：POST 存图，GET 取走。
pub(crate) fn serve() -> Result<(), String> {
    let addr = http_addr()?;
    let listener =
        TcpListener::bind(addr).map_err(|e| format!("could not listen on {addr}: {e}"))?;
    let token = auth_token()?;
    eprintln!("clipimg: listening on {addr}");
    let mut inbox = None;
    for stream in listener.incoming().flatten() {
        let _ = handle(stream, token.as_deref(), &mut inbox);
    }
    Ok(())
}

/// 处理一条 `/image` 请求；token 不匹配回 401。
fn handle(
    mut stream: TcpStream,
    token: Option<&str>,
    inbox: &mut Option<Vec<u8>>,
) -> Result<(), String> {
    set_timeout(&stream)?;
    let (method, path, headers, body) = read_http(&mut stream)?;
    if path.split('?').next() != Some("/image") {
        return reply(&mut stream, 404, "", b"");
    }
    if let Some(expected) = token
        && hdr(&headers, "x-clipimg-token") != Some(expected)
    {
        return reply(&mut stream, 401, "", b"");
    }
    match method.as_str() {
        "POST" if body.is_empty() => reply(&mut stream, 400, "", b""),
        "POST" => {
            *inbox = Some(body);
            reply(&mut stream, 204, "", b"")
        }
        "GET" => match inbox.take() {
            Some(png) => reply(&mut stream, 200, "Content-Type: image/png\r\n", &png),
            None => reply(&mut stream, 404, "", b""),
        },
        _ => reply(&mut stream, 405, "", b""),
    }
}

/// 读完请求行、头和 Content-Length 指定的 body。
fn read_http(stream: &mut TcpStream) -> Result<(String, String, String, Vec<u8>), String> {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    while !head.ends_with("\r\n\r\n") {
        if reader
            .read_line(&mut head)
            .map_err(|e| format!("could not read HTTP request: {e}"))?
            == 0
        {
            return Err("incomplete HTTP request".into());
        }
        if head.len() > 64 * 1024 {
            return Err("HTTP headers too large".into());
        }
    }

    let mut req = head.split_whitespace();
    let method = req.next().unwrap_or_default().to_string();
    let path = req.next().unwrap_or_default().to_string();
    if method.is_empty() || path.is_empty() {
        return Err("malformed HTTP request line".into());
    }

    let n: usize = hdr(&head, "content-length")
        .unwrap_or("0")
        .parse()
        .map_err(|e| format!("invalid Content-Length: {e}"))?;
    if n > MAX_PNG {
        return Err("payload too large".into());
    }
    let mut body = vec![0; n];
    reader
        .read_exact(&mut body)
        .map_err(|_| "incomplete HTTP body".to_string())?;
    Ok((method, path, head, body))
}

fn hdr<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        k.eq_ignore_ascii_case(name).then_some(v.trim())
    })
}

/// 写短响应并关闭连接。
fn reply(stream: &mut TcpStream, status: u16, extra: &str, body: &[u8]) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .and_then(|()| stream.write_all(body))
    .map_err(|e| format!("could not write HTTP response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_put_then_take() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut inbox = None;
            handle(listener.accept().unwrap().0, None, &mut inbox).unwrap();
            handle(listener.accept().unwrap().0, None, &mut inbox).unwrap();
            inbox
        });

        let png = b"\x89PNG";
        let mut post = TcpStream::connect(addr).unwrap();
        write!(
            post,
            "POST /image HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\n\r\n",
            png.len()
        )
        .unwrap();
        post.write_all(png).unwrap();
        let mut response = String::new();
        post.take(1024).read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 204"));

        let mut get = TcpStream::connect(addr).unwrap();
        get.write_all(b"GET /image HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = Vec::new();
        get.take(1024).read_to_end(&mut response).unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
        assert!(response.ends_with(png));
        assert!(server.join().unwrap().is_none());
    }
}
