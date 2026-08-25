/// 命令行目标：WezTerm pane、仅 HTTP 投递、或本机接收服务。
pub(crate) enum Target {
    WezTerm(String),
    Http,
    Serve,
}

/// 解析唯一参数：`--http` / `--serve` / 数字 pane id。
pub(crate) fn target(mut args: impl Iterator<Item = String>) -> Result<Target, String> {
    let target = args.next().ok_or_else(usage)?;
    if args.next().is_some() {
        return Err(usage());
    }
    match target.as_str() {
        "--http" => Ok(Target::Http),
        "--serve" => Ok(Target::Serve),
        pane if pane.parse::<u64>().is_ok() => Ok(Target::WezTerm(target)),
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: clipimg PANE_ID | clipimg --http | clipimg --serve".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_wezterm_and_serve_targets() {
        assert!(matches!(
            target(["--http".into()].into_iter()),
            Ok(Target::Http)
        ));
        assert!(matches!(
            target(["--serve".into()].into_iter()),
            Ok(Target::Serve)
        ));
        assert!(matches!(
            target(["42".into()].into_iter()),
            Ok(Target::WezTerm(pane)) if pane == "42"
        ));
        assert!(target(["bad".into()].into_iter()).is_err());
    }
}
