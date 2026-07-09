# pi-coding-agent 配置

`pi-coding-agent` 的全局配置与扩展目录。本目录包含 `extensions/`（运行时加载的 TypeScript 扩展）与 `skills/`（按需读取的提示词技能包）两大部分。

## 目录结构

```
.
├── AGENTS.md             # 项目级 Agent 行为准则
├── config.yml            # pi 基础配置
├── settings.json         # 模型/会话等运行时设置
├── extensions/           # 扩展源码（启动时自动加载）
└── skills/               # 技能包（按 description 触发）
```

## Extensions

扩展位于 `extensions/`，以 TypeScript 编写，启动时由 pi 加载。每个文件导出一个默认函数 `(pi: ExtensionAPI) => void`，可通过 `pi.registerTool / registerCommand` 注入新能力。

| 文件 | 提供的工具 / 命令 | 说明 |
|---|---|---|
| `codex-image-gen.ts` | `codex_image_gen` 工具、`/image-codex` 命令 | 复用 `codex login` 的 ChatGPT OAuth token 调用 `gpt-image-2` 生图，无需 `OPENAI_API_KEY` |
| `minimax-image-gen.ts` | `minimax_image` 工具 | 复用 `auth.json` 中 `minimax-cn` 的 API key 调用 MiniMax `image-01` / `image-01-live`，支持文生图与图生图（`subject_reference`） |
| `web-search.ts` | `web_search`、`web_fetch` 工具 | 联网搜索与抓取：配置了 `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` 时走 Google Custom Search，否则回落到 Bing RSS |
| `pi-vscode-context.ts` | `vscode_context` 工具、`/vscode`、`/vscode-auto` 命令 | VSCode 配套：通过 loopback socket 与「Pi Agent Context」VSCode 插件通信，自动注入当前文件与选区上下文，支持 `Cmd+Alt+K` 提及 |
| `rtk.ts` | — | RTK（Rust Token Killer）代理：将 bash 命令重写为 `rtk` 等价形式以节省 token；改写逻辑在 `rtk rewrite`（Rust 注册表），本扩展只是薄壳 |
| `orca-agent-status.ts` | — | Orca 管理器集成：监听 `before_agent_start` / `tool_call` / `message_end` 等事件，POST 到 Orca hook 端点（`/hook/pi` 或 `/hook/omp`）上报 Agent 运行状态 |

## Skills

技能位于 `skills/`，每个子目录的 `SKILL.md` 含 `name` + `description` 前置元数据；description 是 LLM 自动触发的唯一依据。技能正文在被触发时按需读取。

| 名称 | 触发场景 |
|---|---|
| `edge-tts` | 用户提到「tts / 语音 / 朗读」或希望把文本转为音频。基于 `uvx edge-tts` 调用 Microsoft Edge 神经语音，支持多语言、语速/音量/音调调节、字幕生成 |
| `pdf` | 任何涉及 PDF 的读取、创建或审阅，且需要关注排版与渲染。基于 Poppler 渲染为图片做视觉检查，`reportlab` 生成，`pdfplumber` / `pypdf` 提取 |
| `pptx` | 任何 `.pptx` 文件相关操作（读取、解析、创建、编辑、合并、模板/版式/备注/批注等），或用户提到「deck / slides / 演示」。提供 markitdown、pptxgenjs、thumbnail、unpack/pack 等脚本，并要求对每张幻灯片做视觉 QA |

## 添加新扩展 / 技能

- **扩展**：在 `extensions/` 下新增 `.ts` 文件，默认导出 `(pi: ExtensionAPI) => void`；重启 pi 即生效。
- **技能**：在 `skills/<name>/` 下新建 `SKILL.md`，首段 YAML 必须包含 `name` 与 `description`；description 写得越具体，触发越精准。
