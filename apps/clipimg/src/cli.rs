/// 命令行目标：WezTerm pane 或 PNG stdout。
pub(crate) enum Target {
    WezTerm(String),
    Stdout,
}

/// 解析唯一参数：`--stdout` 或数字 pane id。
pub(crate) fn target(mut args: impl Iterator<Item = String>) -> Result<Target, String> {
    let target = args.next().ok_or_else(usage)?;
    if args.next().is_some() {
        return Err(usage());
    }
    match target.as_str() {
        "--stdout" => Ok(Target::Stdout),
        pane if pane.parse::<u64>().is_ok() => Ok(Target::WezTerm(target)),
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: clipimg PANE_ID | clipimg --stdout".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_targets() {
        assert!(matches!(
            target(["--stdout".into()].into_iter()),
            Ok(Target::Stdout)
        ));
        assert!(matches!(
            target(["42".into()].into_iter()),
            Ok(Target::WezTerm(pane)) if pane == "42"
        ));
        assert!(target(["bad".into()].into_iter()).is_err());
    }
}
