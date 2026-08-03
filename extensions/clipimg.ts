import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_BASE64 = 24 * 1024 * 1024;
const PNG_PREFIX = "iVBORw0KGgo";

export default function clipimg(pi: ExtensionAPI) {
	let pending: ImageContent[] = [];

	pi.registerCommand("clipimg", {
		description: "Attach a local clipboard image to the next prompt",
		handler: async (args, ctx) => {
			const data = args.trim();
			if (!validPng(data)) {
				ctx.ui.notify("clipimg：图片数据无效", "error");
				return;
			}

			pending.push({ type: "image", data, mimeType: "image/png" });
			ctx.ui.notify(`已附加图片（${formatSize(data.length)}）`, "info");
		},
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive" || pending.length === 0) {
			return { action: "continue" };
		}

		const images = [...(event.images ?? []), ...pending];
		pending = [];
		return { action: "transform", text: event.text, images };
	});

	pi.on("session_shutdown", () => {
		pending = [];
	});
}

function validPng(data: string): boolean {
	return (
		data.length <= MAX_BASE64 &&
		data.length % 4 === 0 &&
		data.startsWith(PNG_PREFIX) &&
		/^[A-Za-z0-9+/]+={0,2}$/.test(data)
	);
}

function formatSize(base64Length: number): string {
	const bytes = Math.floor((base64Length * 3) / 4);
	return `${(bytes / 1024).toFixed(0)} KB`;
}
