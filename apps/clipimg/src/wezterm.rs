use std::io::Write;
use std::process::{Command, Stdio};

/// 向 pane 粘贴文本并回车提交。
pub(crate) fn submit(pane: &str, input: &[u8]) -> Result<(), String> {
    send(pane, input, false)?;
    send(pane, b"\r", true)
}

/// `wezterm cli send-text`；`raw` 时加 `--no-paste`（用于回车）。
fn send(pane: &str, input: &[u8], raw: bool) -> Result<(), String> {
    let mut child = Command::new("wezterm.exe")
        .args(["cli", "send-text", "--pane-id", pane])
        .args(raw.then_some("--no-paste"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not start wezterm.exe: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("could not open wezterm stdin")?
        .write_all(input)
        .map_err(|e| format!("could not write to wezterm: {e}"))?;
    let status = child
        .wait()
        .map_err(|e| format!("could not wait for wezterm.exe: {e}"))?;
    if !status.success() {
        return Err(format!("wezterm.exe exited with {status}"));
    }
    Ok(())
}
