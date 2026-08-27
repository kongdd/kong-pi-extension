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

const MAX_BASE64 = 24 * 1024 * 1024;
const MAX_PNG = (MAX_BASE64 / 4) * 3;
const PNG_PREFIX = "iVBORw0KGgo";
const TOKEN = process.env.CLIPIMG_TOKEN;
const WIDGET_ID = "clipimg";
const THUMB_W = 20;
const THUMB_H = 6;
const GAP = 2;
const SLOT_W = THUMB_W + GAP;
const DIR = join(import.meta.dirname, "..", "media", "clipimg");

type Shot = { path: string; kb: number };
type Details = { files?: { path: string; kb: number }[] };
type Signal = "saving" | "attach" | "failed";

const SIGNALS: Record<string, Signal> = {
  "\x1b[991~": "saving",
  "\x1b[992~": "attach",
  "\x1b[993~": "failed",
};
const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** `/clipimg` 是内部传图命令，不写入输入历史。 */
class ClipimgEditor extends CustomEditor {
  onSignal?: (signal: Signal) => void;
  onImage?: (data: string) => void;

  override addToHistory(text: string) {
    if (/^\/clipimg(?::\d+)?(?:\s|$)/.test(text)) return;
    super.addToHistory(text);
  }

  override handleInput(data: string) {
    if (data.startsWith(PASTE_BEGIN) && data.endsWith(PASTE_END)) {
      const pasted = data.slice(PASTE_BEGIN.length, -PASTE_END.length);
      if (pasted.startsWith(PNG_PREFIX)) {
        this.onImage?.(pasted);
        return;
      }
    }

    const signal = SIGNALS[data];
    if (!signal) return super.handleInput(data);
    this.onSignal?.(signal);
  }
}

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

/** 默认接收客户端私有帧；`/clipimg` 无参数时仍可从 HTTP 收件箱取图。 */
export default function clipimg(pi: ExtensionAPI) {
  let pending: Shot[] = [];
  let savingAt: number | undefined;

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new ClipimgEditor(tui, theme, keybindings);
      editor.onImage = (data) => void handleCommand(data, ctx);
      editor.onSignal = (signal) => {
        if (signal === "failed") {
          savingAt = undefined;
          ctx.ui.notify("clipimg：上传失败", "error");
          return;
        }
        void handleCommand(signal === "saving" ? "saving" : "", ctx);
      };
      return editor;
    });
  });

  pi.registerMessageRenderer(WIDGET_ID, (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 0, (t) => theme.bg("userMessageBg", t));
    const files = (message.details as Details | undefined)?.files;
    if (files?.length) {
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
    } else {
      const parts = typeof message.content === "string" ? [] : message.content;
      let i = 0;
      for (const part of parts) {
        if (part.type !== "image") continue;
        box.addChild(
          new Image(part.data, part.mimeType, { fallbackColor: (s) => theme.fg("muted", s) }, {
            maxWidthCells: THUMB_W,
            maxHeightCells: THUMB_H,
          }),
        );
        box.addChild(new Text(theme.fg("muted", `[${++i}] ${kb(part.data)} KB`), 0, 0));
      }
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

  function attach(data: string, ctx: ExtensionContext) {
    if (!isPng(data)) {
      ctx.ui.notify("clipimg：图片数据无效", "error");
      return false;
    }
    pending.push(save(data));
    update(ctx);
    return true;
  }

  async function handleCommand(args: string, ctx: ExtensionContext) {
    let data = args.trim();
    if (data === "saving") {
      savingAt = performance.now();
      ctx.ui.notify("saving...", "info");
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
    savingAt ??= performance.now();
    if (!data) {
      try {
        data = await fetchImage();
      } catch (error) {
        savingAt = undefined;
        ctx.ui.notify(`clipimg HTTP：${error instanceof Error ? error.message : error}`, "error");
        return;
      }
    }
    const started = savingAt;
    savingAt = undefined;
    if (attach(data, ctx)) {
      ctx.ui.notify(`saving used ${((performance.now() - started) / 1000).toFixed(2)}s`, "info");
    }
  }

  pi.registerCommand("clipimg", {
    description: "Attach a PNG; no args GETs http://127.0.0.1:17323/image; clear [1,2,...] removes pending images",
    handler: handleCommand,
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || pending.length === 0) return { action: "continue" };
    const files = pending.map(({ path, kb }) => ({ path, kb }));
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

  pi.on("session_shutdown", () => {
    pending = [];
  });
}

async function fetchImage() {
  const response = await fetch(`http://${process.env.CLIPIMG_ADDR ?? "127.0.0.1:17323"}/image`, {
    headers: TOKEN ? { "X-Clipimg-Token": TOKEN } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "image/png") {
    throw new Error("expected image/png");
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_PNG) throw new Error("image too large");
  const data = buf.toString("base64");
  if (!isPng(data)) throw new Error("invalid PNG");
  return data;
}

function save(data: string): Shot {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${Date.now()}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  return { path, kb: kb(data) };
}

function loadPng(path: string) {
  try {
    const data = readFileSync(path).toString("base64");
    return isPng(data) ? data : undefined;
  } catch {
    return;
  }
}

function kb(data: string) {
  return Math.floor((data.length * 3) / 4 / 1024);
}

function isPng(data: string) {
  return (
    data.length <= MAX_BASE64 &&
    data.length % 4 === 0 &&
    data.startsWith(PNG_PREFIX) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data)
  );
}
