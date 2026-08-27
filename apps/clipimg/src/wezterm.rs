use std::io::Write;
use std::process::{Command, Stdio};

pub(crate) const SAVING: &[u8] = b"\x1b[991~";
pub(crate) const ATTACH: &[u8] = b"\x1b[992~";
pub(crate) const FAILED: &[u8] = b"\x1b[993~";

/// 向 pane 发送 clipimg 私有控制信号，不提交编辑器内容。
pub(crate) fn signal(pane: &str, input: &[u8]) -> Result<(), String> {
    let mut child = Command::new("wezterm.exe")
        .args(["cli", "send-text", "--pane-id", pane, "--no-paste"])
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
