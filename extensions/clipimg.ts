import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  allocateImageId,
  Box,
  getCapabilities,
  getImageDimensions,
  Image,
  renderImage,
  Text,
} from "@earendil-works/pi-tui";

const MAX_PNG = 18 * 1024 * 1024;
const WIDGET_ID = "clipimg";
const THUMB_W = 20;
const THUMB_H = 6;
const GAP = 2;
const SLOT_W = THUMB_W + GAP;
const DIR = join(import.meta.dirname, "..", "media", "clipimg");

type Shot = { path: string; kb: number };
type Details = { files?: Shot[] };

/** WezTerm/Kitty 横排缩略图。 */
class Thumbnails {
  private cache?: { width: number; lines: string[] };
  private ids: number[] = [];

  constructor(
    private images: Shot[],
    private theme: Theme,
  ) { }

  invalidate() {
    this.cache = undefined;
  }

  private remember(width: number, lines: string[]) {
    this.cache = { width, lines };
    return lines;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    if (getCapabilities().images !== "kitty") {
      return this.remember(width, [this.theme.fg("muted", `[${this.images.length} 张图片待发送]`)]);
    }

    const limit = Math.max(1, Math.floor((width + GAP) / SLOT_W));
    const previews = this.images.slice(0, limit).flatMap((image, i) => {
      const data = loadPng(image.path);
      const dimensions = data && getImageDimensions(data, "image/png");
      const rendered =
        data &&
        dimensions &&
        renderImage(data, dimensions, {
          maxWidthCells: THUMB_W,
          maxHeightCells: THUMB_H,
          moveCursor: false,
          imageId: (this.ids[i] ??= allocateImageId()),
        });
      return rendered ? [{ ...rendered, kb: image.kb, index: i + 1 }] : [];
    });
    if (previews.length === 0) {
      return this.remember(width, [this.theme.fg("muted", `[${this.images.length} 张图片无法预览]`)]);
    }

    const top = previews
      .map((preview, i) => preview.sequence + (i + 1 < previews.length ? " ".repeat(SLOT_W) : ""))
      .join("");
    const rows = Math.max(...previews.map((preview) => preview.rows));
    const hidden = this.images.length - previews.length;
    const labels = previews
      .map((preview, i) => `[${preview.index}] ${preview.kb} KB`.padEnd(i + 1 < previews.length ? SLOT_W : 0))
      .join("");
    const footer = `${labels}${hidden ? `  +${hidden}` : ""}`.slice(0, width);
    return this.remember(width, [
      top,
      ...Array(rows - 1).fill(""),
      this.theme.fg("muted", footer),
    ]);
  }
}

/** 管理待发送图片。 */
export default function clipimg(pi: ExtensionAPI) {
  let pending: Shot[] = [];

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CustomEditor(tui, theme, keybindings);
      editor.onPasteImage = () => void handleCommand("", ctx);
      return editor;
    });
  });

  pi.registerMessageRenderer(WIDGET_ID, (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 0, (t) => theme.bg("userMessageBg", t));
    const files = (message.details as Details | undefined)?.files ?? [];
    for (const [i, file] of files.entries()) {
      const data = loadPng(file.path);
      if (!data) continue;
      box.addChild(
        new Image(data, "image/png", { fallbackColor: (s) => theme.fg("muted", s) }, {
          maxWidthCells: THUMB_W,
          maxHeightCells: THUMB_H,
        }),
      );
      box.addChild(new Text(theme.fg("muted", `[${i + 1}] ${file.kb} KB`), 0, 0));
    }
    const text = typeof message.content === "string"
      ? message.content
      : message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    if (text) box.addChild(new Text(theme.fg("userMessageText", text), 0, 0));
    return box;
  });

  // 会话只保存图片路径；仅在构造模型上下文时读取为图片数据。
  pi.on("context", (event) => ({
    messages: event.messages.map((m) => {
      if (m.role !== "custom" || m.customType !== WIDGET_ID) return m;
      const files = (m.details as Details | undefined)?.files;
      if (!files?.length) return m;
      const images = files.flatMap((f) => {
        const data = loadPng(f.path);
        return data ? [{ type: "image" as const, data, mimeType: "image/png" }] : [];
      });
      const text = typeof m.content === "string" ? m.content : "";
      return { ...m, content: [...(text ? [{ type: "text" as const, text }] : []), ...images] };
    }),
  }));

  function update(ctx: ExtensionContext) {
    const images = [...pending];
    ctx.ui.setWidget(
      WIDGET_ID,
      images.length ? (_tui, theme) => new Thumbnails(images, theme) : undefined,
    );
  }

  async function handleCommand(args: string, ctx: ExtensionContext) {
    const data = args.trim();
    if (!data) {
      const started = performance.now();
      ctx.ui.notify("saving...", "info");
      try {
        pending.push(save(await fetchClipboard()));
        update(ctx);
        ctx.ui.notify(`saving used ${((performance.now() - started) / 1000).toFixed(2)}s`, "info");
      } catch (error) {
        ctx.ui.notify(`clipimg：${error instanceof Error ? error.message : error}`, "error");
      }
      return;
    }
    if (/^clear(?:\s|$)/.test(data)) {
      const spec = data.slice(5).trim();
      if (!spec) {
        const n = pending.length;
        pending = [];
        update(ctx);
        ctx.ui.notify(n ? `已清空 ${n} 张待发送图片` : "没有待发送图片", "info");
        return;
      }
      if (!/^\d+(?:\s*,\s*\d+)*$/.test(spec)) {
        ctx.ui.notify("clipimg：序号格式无效", "error");
        return;
      }
      const indices = [...new Set(spec.split(",").map(Number))].sort((a, b) => a - b);
      const invalid = indices.filter((i) => i < 1 || i > pending.length);
      if (invalid.length) {
        ctx.ui.notify(`clipimg：序号无效：${invalid.join(",")}`, "error");
        return;
      }
      const selected = new Set(indices);
      pending = pending.filter((_, i) => !selected.has(i + 1));
      update(ctx);
      ctx.ui.notify(`已删除第 ${indices.join(",")} 张图片`, "info");
      return;
    }
    ctx.ui.notify("clipimg：参数无效", "error");
  }

  pi.registerCommand("clipimg", {
    description: "Attach the clipboard image; clear [1,2,...] removes pending images",
    handler: handleCommand,
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || pending.length === 0) return { action: "continue" };
    const files = pending;
    pending = [];
    update(ctx);
    pi.sendMessage(
      {
        customType: WIDGET_ID,
        content: event.text,
        display: true,
        details: { files },
      },
      { triggerTurn: true },
    );
    return { action: "handled" };
  });

}

function fetchClipboard() {
  const remote = Boolean(process.env.SSH_CONNECTION);
  const host = process.env.WIN_SSH_HOST ?? "";
  if (remote && !host) throw new Error("请设置 WIN_SSH_HOST");

  const command = remote ? "ssh" : "clipimg.exe";
  const args = remote
    ? [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=3",
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=10m",
      "-o", `ControlPath=${process.env.HOME}/.ssh/cm-%C`,
      host,
      `"%USERPROFILE%\\.win-launch.exe" --clipboard`,
    ]
    : ["--stdout"];

  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: null, maxBuffer: MAX_PNG, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.toString().trim() || error.message));
        else if (!isPng(stdout)) reject(new Error("图片数据无效"));
        else resolve(stdout);
      },
    );
  });
}

function save(png: Buffer): Shot {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${Date.now()}.png`);
  writeFileSync(path, png);
  return { path, kb: Math.floor(png.length / 1024) };
}

function loadPng(path: string) {
  try {
    const png = readFileSync(path);
    return isPng(png) ? png.toString("base64") : undefined;
  } catch {
    return;
  }
}

function isPng(data: Buffer) {
  return data.length <= MAX_PNG && data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
}
