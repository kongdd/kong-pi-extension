---
name: witr
description: 使用 witr 追溯进程或端口为何运行、由谁启动及其父进程链。用于排查未知进程、端口占用、服务来源、异常重启和可疑运行上下文；触发词包括 witr、为什么这个进程在运行、谁启动了它、端口被谁占用、进程树。
compatibility: 需要系统已安装 witr；部分进程信息可能需要管理员权限。
---

# witr

`witr`（Why Is This Running）把进程名、PID 或端口解析为进程，并追溯其启动链、监管者和运行上下文。

## 基本用法

```bash
witr nginx                 # 按进程名查询
witr --pid 1234            # 按 PID 查询
witr --port 5432           # 查询端口监听者
witr postgres --tree       # 以树形显示进程祖先及子进程
witr sshd --short          # 仅输出单行启动链
witr docker --warnings     # 仅显示风险提示
witr node --env            # 显示进程环境变量
witr mysql --verbose       # 显示内存、I/O、文件描述符等扩展信息
witr --port 8080 --json    # 输出 JSON，便于脚本解析
```

先运行 `witr --help`，以本机版本实际支持的参数为准。

## 排查流程

1. 先执行普通查询，读取 `Process`、`Why It Exists`、`Source`、`Working Dir`、`Sockets` 和 `Warnings`。
2. 进程名匹配多个结果时，使用结果中的 PID 再查：`witr --pid <PID>`。
3. 只需回答“谁启动了它”时使用 `--short`；需要父子关系时使用 `--tree`。
4. 排查暴露端口、root 运行、反复重启或注入变量时使用 `--warnings`。
5. 需要程序化筛选时使用 `--json`，不要解析彩色文本。

## 输出解释

- `Why It Exists`：从 init/systemd、SSH、shell 或监管器到目标进程的因果链。
- `Source`：最可能负责启动或维持该进程的系统，如 systemd、Docker、PM2、cron 或交互式 shell。
- `Warnings`：非阻断风险，如公网监听、root 权限、高内存、频繁重启或 `LD_PRELOAD`。
- `Working Dir`、`Git Repo`、`Sockets`：定位代码来源及网络暴露范围。

## 注意事项

- `--env` 可能暴露令牌、密码和密钥；除非用户明确需要，否则不要使用或原样回显。
- 信息缺失或权限不足时，可建议 `sudo witr ...`；不要擅自提权。
- `witr` 说明启动因果与上下文，不替代 `systemctl status`、日志或性能分析。
- 脚本中应区分退出码：`0` 正常，`1` 有警告，`2` 未找到，`3` 权限不足，`4` 输入无效，`5` 内部错误；不要把退出码 `1` 一律视为执行失败。
