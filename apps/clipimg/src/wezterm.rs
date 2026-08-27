use std::io::Write;
use std::process::{Command, Stdio};

/// 向 pane 粘贴图片数据；扩展会按 PNG 签名拦截，不修改当前输入。
pub(crate) fn send_image(pane: &str, data: &str) -> Result<(), String> {
    send(pane, data.as_bytes())
}

fn send(pane: &str, input: &[u8]) -> Result<(), String> {
    let mut child = Command::new("wezterm.exe")
        .args(["cli", "send-text", "--pane-id", pane])
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
