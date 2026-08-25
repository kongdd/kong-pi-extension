import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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

type Shot = ImageContent & { path: string; kb: number };
type Details = { files?: { path: string; kb: number }[] };

/** WezTerm/Kitty 横排缩略图。 */
class Thumbnails {
	private cache?: { width: number; lines: string[] };
	private ids: number[] = [];

	constructor(
		private images: ImageContent[],
		private theme: Theme,
	) {}

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
			const dimensions = getImageDimensions(image.data, image.mimeType);
			const rendered =
				dimensions &&
				renderImage(image.data, dimensions, {
					maxWidthCells: THUMB_W,
					maxHeightCells: THUMB_H,
					moveCursor: false,
					imageId: (this.ids[i] ??= allocateImageId()),
				});
			return rendered ? [rendered] : [];
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
			.map((_, i) => `${kb(this.images[i].data)} KB`.padEnd(i + 1 < previews.length ? SLOT_W : 0))
			.join(" ");
		const footer = `${labels}${hidden ? `  +${hidden}` : ""}`.slice(0, width);
		return this.remember(width, [
			top,
			...Array(rows - 1).fill(""),
			this.theme.fg("muted", footer),
		]);
	}
}

/** 收图由外部 `clipimg --serve`（默认 :17323）提供，本扩展只 GET。 */
export default function clipimg(pi: ExtensionAPI) {
	let pending: Shot[] = [];

	pi.registerMessageRenderer(WIDGET_ID, (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 0, (t) => theme.bg("userMessageBg", t));
		const files = (message.details as Details | undefined)?.files;
		if (files?.length) {
			for (const file of files) {
				const data = loadPng(file.path);
				if (!data) continue;
				box.addChild(
					new Image(data, "image/png", { fallbackColor: (s) => theme.fg("muted", s) }, {
						maxWidthCells: THUMB_W,
						maxHeightCells: THUMB_H,
					}),
				);
				box.addChild(new Text(theme.fg("muted", `${file.kb} KB`), 0, 0));
			}
		} else {
			const parts = typeof message.content === "string" ? [] : message.content;
			for (const part of parts) {
				if (part.type !== "image") continue;
				box.addChild(
					new Image(part.data, part.mimeType, { fallbackColor: (s) => theme.fg("muted", s) }, {
						maxWidthCells: THUMB_W,
						maxHeightCells: THUMB_H,
					}),
				);
				box.addChild(new Text(theme.fg("muted", `${kb(part.data)} KB`), 0, 0));
			}
		}
		const text = typeof message.content === "string"
			? message.content
			: message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
		if (text) box.addChild(new Text(theme.fg("userMessageText", text), 0, 0));
		return box;
	});

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
			return;
		}
		pending.push(save(data));
		update(ctx);
	}

	pi.registerCommand("clipimg", {
		description: "Attach a PNG; no args GETs http://127.0.0.1:17323/image; clear [1,2,...] removes pending images",
		handler: async (args, ctx) => {
			let data = args.trim();
			if (data === "saving") {
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
			if (!data) {
				try {
					data = await fetchImage();
				} catch (error) {
					ctx.ui.notify(`clipimg HTTP：${error instanceof Error ? error.message : error}`, "error");
					return;
				}
			}
			attach(data, ctx);
		},
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
	return { type: "image", data, mimeType: "image/png", path, kb: kb(data) };
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
