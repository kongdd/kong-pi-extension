use std::io::Write;
use std::process::{Command, Stdio};

const IMAGE_BEGIN: &str = "\x1b[994~";
const IMAGE_END: &str = "\x1b[995~";

/// 向 pane 发送图片数据，不回车、不改写当前输入。
pub(crate) fn send_image(pane: &str, data: &str) -> Result<(), String> {
    send(pane, IMAGE_BEGIN.as_bytes(), true)?;
    let result = send(pane, data.as_bytes(), false);
    let end = send(pane, IMAGE_END.as_bytes(), true);
    result.and(end)
}

/// 控制符不走 paste；图片正文用 paste 合并为一个输入事件。
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
