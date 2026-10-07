import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  allocateImageId,
  Container,
  getCapabilities,
  getCellDimensions,
  Image,
  resetCapabilitiesCache,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const MAX_PNG = 18 * 1024 * 1024;
const WIDGET_ID = "clipimg";
const THUMB_W = 20;
const THUMB_H = 6;
const GAP = 1;
const DIR = join(import.meta.dirname, "..", "media", "clipimg");
const require = createRequire(join(getPackageDir(), "package.json"));

type Shot = { path: string; kb: number };
type Details = { files?: Shot[] };

/** 横排合成一张 PNG，避免同一行多张 Kitty 图片无法被 pi 完整追踪。 */
function thumbnailStrip(files: Shot[], columns: number) {
  // 复用 pi 已安装的 Photon，不增加依赖。
  const { PhotonImage, resize, watermark, SamplingFilter } = require("@silvia-odwyer/photon-node");
  const cell = getCellDimensions();
  const height = THUMB_H * cell.heightPx;
  const allocated = [];
  const thumbs = [];
  let used = 0;
  let labels = "";
  try {
    for (const [i, file] of files.entries()) {
      const label = `[${i + 1}] ${file.kb} KB`;
      const x = used + (i ? GAP : 0);
      if (x + Math.min(columns, label.length) > columns) break;
      const data = loadPng(file.path);
      if (!data) throw new Error(`第 ${i + 1} 张图片无法读取`);
      const source = PhotonImage.new_from_base64(data);
      allocated.push(source);
      const scale = Math.min(
        (Math.min(THUMB_W, columns) * cell.widthPx) / source.get_width(),
        height / source.get_height(),
      );
      const width = Math.max(1, Math.round(source.get_width() * scale));
      // 按实际图宽排版，只为标签保留必要空间。
      const slot = Math.min(columns, Math.max(Math.ceil(width / cell.widthPx), label.length));
      if (x + slot > columns) break;
      const image = resize(
        source, width, Math.max(1, Math.round(source.get_height() * scale)),
        SamplingFilter.Lanczos3,
      );
      allocated.push(image);
      thumbs.push({ image, x });
      labels = labels.padEnd(x) + label;
      used = x + slot;
    }
    const width = used * cell.widthPx;
    const sheet = new PhotonImage(new Uint8Array(width * height * 4), width, height);
    allocated.push(sheet);
    for (const { image, x } of thumbs) {
      watermark(sheet, image, BigInt(x * cell.widthPx), 0n);
    }
    return {
      data: Buffer.from(sheet.get_bytes()).toString("base64"),
      labels,
      count: thumbs.length,
    };
  } finally {
    for (const image of allocated) image.free();
  }
}

/** 一个图片块占六行，标签独占一行；占位行不能套 Box 填充背景。 */
class Thumbnails {
  private imageId = allocateImageId();
  private cache?: { width: number; protocol: string | null; lines: string[] };

  constructor(private images: Shot[], private theme: Theme) {}

  invalidate() {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const protocol = getCapabilities().images;
    if (this.cache?.width === width && this.cache.protocol === protocol) return this.cache.lines;
    let lines: string[] = [];
    let footer = `[${this.images.length} 张图片]`;
    try {
      if (protocol) {
        const columns = Math.max(1, width - 2);
        const strip = thumbnailStrip(this.images, columns);
        const image = new Image(
          strip.data,
          "image/png",
          { fallbackColor: (s) => this.theme.fg("muted", s) },
          { maxWidthCells: columns, maxHeightCells: THUMB_H, imageId: this.imageId },
        );
        const hidden = this.images.length - strip.count;
        const suffix = hidden ? `  +${hidden}` : "";
        footer = truncateToWidth(strip.labels, Math.max(0, width - suffix.length), "") + suffix;
        lines = [...image.render(width)];
      }
    } catch (error) {
      footer = `图片无法预览：${error instanceof Error ? error.message : error}`;
    }
    // 终端间距以整行为单位，隔开大小标签与正文或输入框。
    lines.push(this.theme.fg("muted", truncateToWidth(footer, width)), "");
    this.cache = { width, protocol, lines };
    return lines;
  }
}

/** 管理待发送图片。 */
export default function clipimg(pi: ExtensionAPI) {
  // 必须在 TUI 启动前确定协议；渲染时才开启会导致全屏模式不清理图片。
  // 环境变量仅补充 Herdr 默认值，仍由 terminal.images 设置及显式环境变量覆盖。
  if (process.env.TERM_PROGRAM?.toLowerCase() === "herdr" && !process.env.PI_IMAGE_PROTOCOL) {
    process.env.PI_IMAGE_PROTOCOL = "kitty";
    resetCapabilitiesCache();
  }
  let pending: Shot[] = [];

  pi.registerShortcut(process.platform === "darwin" ? "ctrl+v" : "alt+v", {
    description: "Attach the clipboard image",
    handler: (ctx) => void handleCommand("", ctx),
  });

  pi.registerMessageRenderer(WIDGET_ID, (message, { outputPad }, theme) => {
    const container = new Container();
    const files = (message.details as Details | undefined)?.files ?? [];
    if (files.length) container.addChild(new Thumbnails(files, theme));
    const text = typeof message.content === "string"
      ? message.content
      : message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    if (text) {
      container.addChild(new Text(
        theme.fg("userMessageText", text), outputPad, 0,
        (t) => theme.bg("userMessageBg", t),
      ));
    }
    return container;
  });

  // 剪贴板图片只保存路径；仅在构造模型上下文时读取为图片数据。
  pi.on("context", (event) => ({
    messages: event.messages.map((m) => {
      if (m.role !== "custom" || m.customType !== WIDGET_ID) return m;
      const files = (m.details as Details | undefined)?.files;
      if (!files?.length) return m;
      const images = files.flatMap((f) => {
        const data = loadPng(f.path);
        return data ? [{ type: "image" as const, data, mimeType: "image/png" }] : [];
      });
      const content = typeof m.content === "string"
        ? (m.content ? [{ type: "text" as const, text: m.content }] : [])
        : m.content;
      return { ...m, content: [...content, ...images] };
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
    try {
      let message: string;
      if (!data) {
        const started = performance.now();
        ctx.ui.notify("saving...", "info");
        pending.push(await captureClipboard());
        message = `saving used ${((performance.now() - started) / 1000).toFixed(2)}s`;
      } else {
        if (!/^clear(?:\s|$)/.test(data)) throw new Error("参数无效");
        const spec = data.slice(5).trim();
        if (!spec) {
          message = pending.length ? `已清空 ${pending.length} 张待发送图片` : "没有待发送图片";
          pending = [];
        } else {
          const selected = new Set(spec.split(",").flatMap((part) => {
            if (!/^\d+(?:\s*-\s*\d+)?$/.test(part.trim())) throw new Error("序号格式无效");
            const [start, end = start] = part.split("-").map(Number);
            if (end < start) throw new Error("序号范围无效");
            // 越界范围只检查端点，避免展开巨大的无效范围。
            if (start < 1 || end > pending.length) return [start, end];
            return Array.from({ length: end - start + 1 }, (_, i) => start + i);
          }));
          const indices = [...selected].sort((a, b) => a - b);
          const invalid = indices.filter((i) => i < 1 || i > pending.length);
          if (invalid.length) throw new Error(`序号无效：${invalid.join(",")}`);
          pending = pending.filter((_, i) => !selected.has(i + 1));
          message = `已删除第 ${indices.join(",")} 张图片`;
        }
      }
      update(ctx);
      ctx.ui.notify(message, "info");
    } catch (error) {
      ctx.ui.notify(`clipimg：${error instanceof Error ? error.message : error}`, "error");
    }
  }

  pi.registerCommand("clipimg", {
    description: "Attach the clipboard image; clear [1,3-5,...] removes pending images",
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
        content: event.images?.length
          ? [{ type: "text", text: event.text }, ...event.images]
          : event.text,
        display: true,
        details: { files },
      },
      { triggerTurn: true },
    );
    return { action: "handled" };
  });
}

async function captureClipboard(): Promise<Shot> {
  const remote = Boolean(process.env.SSH_CONNECTION);
  const host = process.env.WIN_SSH_HOST ?? "";
  if (remote && !host) throw new Error("请设置 WIN_SSH_HOST");

  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${randomUUID()}.png`);
  const command = remote ? "ssh" : process.platform === "win32" ? "clipimg.exe" : "clipimg";
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
    : ["--output", path];
  const { stdout } = await execFileAsync(command, args, {
    encoding: null,
    maxBuffer: MAX_PNG,
    timeout: 10_000,
  });
  if (remote) {
    if (!isPng(stdout)) throw new Error("图片数据无效");
    writeFileSync(path, stdout);
  }
  return { path, kb: Math.floor(statSync(path).size / 1024) };
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
