import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	getImageDimensions,
	renderImage,
} from "@earendil-works/pi-tui";

const MAX_BASE64 = 24 * 1024 * 1024;
const PNG_PREFIX = "iVBORw0KGgo";
const WIDGET_ID = "clipimg";
const THUMB_W = 20;
const THUMB_H = 6;
const GAP = 2;
const SLOT_W = THUMB_W + GAP;

/** WezTerm/Kitty 横排缩略图。 */
class Thumbnails {
	private cache?: { width: number; lines: string[] };

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
		const previews = this.images.slice(0, limit).flatMap((image) => {
			const dimensions = getImageDimensions(image.data, image.mimeType);
			const rendered =
				dimensions &&
				renderImage(image.data, dimensions, {
					maxWidthCells: THUMB_W,
					maxHeightCells: THUMB_H,
					moveCursor: false,
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
			.map((_, i) => `${i + 1}`.padEnd(i + 1 < previews.length ? SLOT_W : 1))
			.join("");
		const footer = `${labels}${hidden ? `  +${hidden}` : ""}`.slice(0, width);
		return this.remember(width, [
			top,
			...Array(rows - 1).fill(""),
			this.theme.fg("muted", footer),
		]);
	}
}

export default function clipimg(pi: ExtensionAPI) {
	let pending: ImageContent[] = [];

	function update(ctx: ExtensionContext) {
		const images = [...pending];
		ctx.ui.setWidget(
			WIDGET_ID,
			images.length ? (_tui, theme) => new Thumbnails(images, theme) : undefined,
		);
	}

	pi.registerCommand("clipimg", {
		description: "Attach a PNG; clear [1,2,...] removes pending images",
		handler: async (args, ctx) => {
			const data = args.trim();
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
			if (!isPng(data)) {
				ctx.ui.notify("clipimg：图片数据无效", "error");
				return;
			}

			pending.push({ type: "image", data, mimeType: "image/png" });
			update(ctx);
			ctx.ui.notify(`已附加 ${pending.length} 张图片（${formatSize(data.length)}）`, "info");
		},
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || pending.length === 0) return { action: "continue" };

		const images = [...(event.images ?? []), ...pending];
		pending = [];
		update(ctx);
		return { action: "transform", text: event.text, images };
	});

	pi.on("session_shutdown", () => {
		pending = [];
	});
}

function isPng(data: string) {
	return (
		data.length <= MAX_BASE64 &&
		data.length % 4 === 0 &&
		data.startsWith(PNG_PREFIX) &&
		/^[A-Za-z0-9+/]+={0,2}$/.test(data)
	);
}

function formatSize(length: number) {
	return `${Math.floor((length * 3) / 4 / 1024)} KB`;
}
