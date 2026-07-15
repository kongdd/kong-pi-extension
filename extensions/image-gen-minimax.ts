/**
 * MiniMax Image Generation — pi extension
 *
 * 只做一件事：复用 pi `auth.json` 中 `minimax-cn` 的 api_key，
 * 注册 `image_minimax` 工具并调用 `POST /v1/image_generation`。
 *
 * API: https://platform.minimaxi.com/docs/guides/image-generation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";

const ENDPOINT = "https://api.minimaxi.com/v1/image_generation";
const PROVIDER = "minimax-cn";
const MODELS = ["image-01", "image-01-live"] as const;
const ASPECT_RATIOS = ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"] as const;
const RESPONSE_FORMATS = ["base64", "url"] as const;
const RETRY_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

type Model = (typeof MODELS)[number];
type AspectRatio = (typeof ASPECT_RATIOS)[number];
type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

type ImageResponse = {
	id?: string;
	data?: { image_base64?: string[]; image_urls?: string[] };
	metadata?: { success_count?: number; failed_count?: number };
	base_resp?: { status_code: number; status_msg: string };
};

const abs = (path: string) => (isAbsolute(path) ? path : resolve(process.cwd(), path));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const loadApiKey = (): string => {
	const credential = AuthStorage.create().get(PROVIDER);
	if (credential?.type !== "api_key" || !credential.key) {
		throw new Error(`MiniMax 认证不可用：请在 auth.json 的 "${PROVIDER}" 中配置 api_key`);
	}
	return credential.key;
};

const generateImage = async (apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ImageResponse> => {
	const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal });
			if (res.ok) return (await res.json()) as ImageResponse;
			throw new HttpError(res.status, (await res.text().catch(() => "")).slice(0, 500));
		} catch (err) {
			if (!(err instanceof HttpError) || !RETRY_HTTP.has(err.status) || attempt === 3) throw err;
			await sleep(800 * attempt);
		}
	}
	throw new Error("unreachable");
};

const downloadToBase64 = async (url: string): Promise<{ b64: string; mime: string }> => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url.slice(0, 120)}`);
	return { b64: Buffer.from(await res.arrayBuffer()).toString("base64"), mime: res.headers.get("content-type") ?? "image/jpeg" };
};

const mimeToExt = (mime: string) => (mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg");

const saveImage = (b64: string, mime: string, path: string) => {
	const final = extname(path) ? path : `${path}.${mimeToExt(mime)}`;
	mkdirSync(dirname(final), { recursive: true });
	writeFileSync(final, Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
	return final;
};

// 解析 "<prompt> key=value ..." 形式的命令参数，已知 key 抽离，其余拼为 prompt
const parseCmdArgs = (raw: string, keys: string[]) => {
	const opts: Record<string, string> = {};
	const parts: string[] = [];
	for (const tok of raw.split(/\s+/).filter(Boolean)) {
		const m = tok.match(/^([a-z_]+)=(.+)$/);
		if (m && keys.includes(m[1])) opts[m[1]] = m[2];
		else parts.push(tok);
	}
	return { prompt: parts.join(" "), opts };
};

const Params = Type.Object({
	prompt: Type.String({ description: "图像生成提示词（英文最佳；最长 1500 字符）" }),
	model: Type.Optional(StringEnum(MODELS, { description: "模型，默认 image-01" })),
	aspect_ratio: Type.Optional(StringEnum(ASPECT_RATIOS, { description: "宽高比，默认 1:1" })),
	n: Type.Optional(Type.Integer({ minimum: 1, maximum: 9, description: "生成数量 1-9，默认 1" })),
	seed: Type.Optional(Type.Integer({ description: "随机种子，相同 seed+参数可复现" })),
	prompt_optimizer: Type.Optional(Type.Boolean({ description: "是否开启 prompt 自动优化，默认 false" })),
	subject_reference: Type.Optional(
		Type.String({ description: "参考图 URL（图生图，type 固定 character）；同时只能传一张" }),
	),
	response_format: Type.Optional(
		StringEnum(RESPONSE_FORMATS, { description: "响应格式，默认 base64（直接落盘）；选 url 会再下载一次" }),
	),
	save_to: Type.Optional(
		Type.String({ description: "保存路径（绝对或相对 cwd），n=1 时使用；n>1 自动加 -1/-2… 后缀。默认 ./minimax-image-<timestamp>.<ext>" }),
	),
});

export default function minimaxImageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "image_minimax",
		label: "MiniMax Image Generate",
		description:
			"通过 auth.json 中 minimax-cn 的 api_key 调用 minimax image-01 / image-01-live 生图（支持 t2i 与 i2i 参考图），默认 base64 落盘到当前工作目录。",
		promptSnippet: "Generate an image from a text prompt via MiniMax image-01 / image-01-live (supports image-to-image via subject_reference)",
		promptGuidelines: ["使用 image_minimax 时用英文提示词效果最佳。"],
		parameters: Params,
		async execute(_id, params, signal, onUpdate) {
			const started = Date.now();
			const apiKey = loadApiKey();
			const model: Model = params.model ?? "image-01";
			const format: ResponseFormat = params.response_format ?? "base64";
			const n = params.n ?? 1;
			onUpdate?.({ content: [{ type: "text", text: `→ ${model}（${format}，n=${n}）：提交生成任务…` }] });

			const body: Record<string, unknown> = { model, prompt: params.prompt, response_format: format, n };
			if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
			if (params.seed !== undefined) body.seed = params.seed;
			if (params.prompt_optimizer !== undefined) body.prompt_optimizer = params.prompt_optimizer;
			if (params.subject_reference) {
				body.subject_reference = [{ type: "character", image_file: params.subject_reference }];
			}

			const response = await generateImage(apiKey, body, signal);

			const base = response.base_resp;
			if (base && base.status_code !== 0) {
				throw new Error(`minimax 返回错误 ${base.status_code}：${base.status_msg}`);
			}

			const b64Items = format === "base64" ? response.data?.image_base64 : undefined;
			const urlItems = format === "url" ? response.data?.image_urls : undefined;

			if ((!b64Items || b64Items.length === 0) && (!urlItems || urlItems.length === 0)) {
				throw new Error(`图像响应为空：${JSON.stringify(response).slice(0, 200)}`);
			}

			const basePath = abs(params.save_to ?? `minimax-image-${Date.now()}`);
			const stampPath = (i: number) => {
				if (i === 0) return basePath;
				const ext = extname(basePath);
				return ext ? `${basePath.slice(0, -ext.length)}-${i + 1}${ext}` : `${basePath}-${i + 1}`;
			};

			const saved: string[] = [];
			if (b64Items && b64Items.length > 0) {
				b64Items.forEach((b64, i) => saved.push(saveImage(b64, "image/jpeg", stampPath(i))));
			} else if (urlItems) {
				for (let i = 0; i < urlItems.length; i++) {
					const { b64, mime } = await downloadToBase64(urlItems[i]!);
					saved.push(saveImage(b64, mime, stampPath(i)));
				}
			}

			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			onUpdate?.({ content: [{ type: "text", text: `✓ 已保存 ${saved.join(", ")}（${seconds}s）` }] });

			const meta = response.metadata;
			const summary =
				`✅ ${saved.join("\n")}\n` +
				`model：${model}` +
				(params.aspect_ratio ? `；aspect_ratio：${params.aspect_ratio}` : "") +
				(meta?.success_count !== undefined ? `；成功 ${meta.success_count} / 失败 ${meta.failed_count ?? 0}` : "") +
				(response.id ? `\ntask_id：${response.id}` : "");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					paths: saved,
					model,
					aspect_ratio: params.aspect_ratio,
					n,
					task_id: response.id,
					success_count: meta?.success_count,
					failed_count: meta?.failed_count,
				},
			};
		},
	});

	// 快速生图命令：/minimax-image <prompt> [model=.. aspect_ratio=.. n=.. save_to=..]
	pi.registerCommand("image-minimax", {
		description:
			"快速生图（MiniMax image-01），用法 /image-minimax <prompt> [model=.. aspect_ratio=.. n=.. save_to=..]",
		handler: async (args, ctx) => {
			const keys = ["model", "aspect_ratio", "n", "seed", "prompt_optimizer", "subject_reference", "save_to"];
			const { prompt, opts } = parseCmdArgs(args.trim(), keys);
			if (!prompt) {
				ctx.ui.notify("用法：/image-minimax <prompt> [model=.. aspect_ratio=.. n=.. save_to=..]", "warning");
				return;
			}
			const started = Date.now();
			const key = "image-minimax";
			const tick = () => ctx.ui.setStatus(key, `生成中…已用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
			tick();
			const timer = setInterval(tick, 500);
			try {
				const apiKey = loadApiKey();
				const model: Model = (opts.model as Model) ?? "image-01";
				const n = opts.n ? Math.max(1, Math.min(9, parseInt(opts.n, 10) || 1)) : 1;
				const body: Record<string, unknown> = { model, prompt, response_format: "base64", n };
				if (opts.aspect_ratio) body.aspect_ratio = opts.aspect_ratio;
				if (opts.seed !== undefined) body.seed = parseInt(opts.seed, 10);
				if (opts.prompt_optimizer !== undefined) body.prompt_optimizer = opts.prompt_optimizer === "true";
				if (opts.subject_reference)
					body.subject_reference = [{ type: "character", image_file: opts.subject_reference }];

				const response = await generateImage(apiKey, body);
				const base = response.base_resp;
				if (base && base.status_code !== 0)
					throw new Error(`minimax 返回错误 ${base.status_code}：${base.status_msg}`);
				const b64Items = response.data?.image_base64;
				if (!b64Items || b64Items.length === 0)
					throw new Error(`图像响应为空：${JSON.stringify(response).slice(0, 200)}`);

				const basePath = abs(opts.save_to ?? `minimax-image-${Date.now()}`);
				const ext = extname(basePath);
				const saved = b64Items!.map((b64, i) => {
					const p =
						i === 0
							? basePath
							: ext
									? `${basePath.slice(0, -ext.length)}-${i + 1}${ext}`
									: `${basePath}-${i + 1}`;
					return saveImage(b64, "image/jpeg", p);
				});
				const seconds = ((Date.now() - started) / 1000).toFixed(1);
				ctx.ui.notify(`✓ ${saved.join(", ")}（${seconds}s）`, "info");
			} catch (err) {
				ctx.ui.notify(`image-minimax 失败：${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				clearInterval(timer);
				ctx.ui.setStatus(key, undefined);
			}
		},
	});
}
