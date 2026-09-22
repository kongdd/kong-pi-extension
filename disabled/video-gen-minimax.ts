/**
 * MiniMax Video Generation — pi extension
 *
 * 复用 auth.json 中 `minimax-cn` 的 api_key：
 * - MiniMax-H3 → POST /v2/video_generation（多模态 content）
 * - Hailuo 系列 → POST /v1/video_generation（文/图生视频）
 * 异步轮询后落盘 mp4。
 *
 * Docs: https://platform.minimaxi.com/docs/guides/video-generation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";

const BASE = "https://api.minimaxi.com";
const PROVIDER = "minimax-cn";
const POLL_MS = 10_000;
const DEFAULT_TIMEOUT_S = 900;

const H3 = "MiniMax-H3" as const;
const DEFAULT_MODEL = "MiniMax-Hailuo-2.3" as const; // TokenPlan/Credit 暂不支持 H3
const HAILUO = [
	DEFAULT_MODEL,
	"MiniMax-Hailuo-2.3-Fast",
	"MiniMax-Hailuo-02",
	"T2V-01-Director",
	"T2V-01",
	"I2V-01-Director",
	"I2V-01-live",
	"I2V-01",
] as const;
const MODELS = [H3, ...HAILUO] as const;
const RESOLUTIONS = ["720P", "768P", "1080P", "2K"] as const;
const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] as const;

type Model = (typeof MODELS)[number];
type Resolution = (typeof RESOLUTIONS)[number];
type Ratio = (typeof RATIOS)[number];

type CreateResp = {
	task_id?: string;
	base_resp?: { status_code: number; status_msg: string };
	type?: string;
	error?: { message?: string };
};

type V1Query = {
	task_id?: string;
	status?: string;
	file_id?: string | number;
	video_width?: number;
	video_height?: number;
	base_resp?: { status_code: number; status_msg: string };
};

type V2Query = {
	task?: {
		id?: string;
		status?: string;
		content?: { url?: string };
		resolution?: string;
		duration?: number;
		ratio?: string;
		error?: unknown;
	};
};

type FileResp = {
	file?: { file_id?: string | number; download_url?: string; filename?: string };
	base_resp?: { status_code: number; status_msg: string };
};

const abs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(() => resolve(), ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});

const loadApiKey = (): string => {
	const c = readStoredCredential(PROVIDER);
	if (c?.type !== "api_key" || !c.key) {
		throw new Error(`MiniMax 认证不可用：请在 auth.json 的 "${PROVIDER}" 中配置 api_key`);
	}
	return c.key;
};

const authHeaders = (key: string) => ({
	Authorization: `Bearer ${key}`,
	"Content-Type": "application/json",
});

const assertOk = (base?: { status_code: number; status_msg: string }) => {
	if (base && base.status_code !== 0) {
		throw new Error(`minimax 错误 ${base.status_code}：${base.status_msg}`);
	}
};

const isUrl = (s: string) => /^https?:\/\//i.test(s) || s.startsWith("data:");

/** 本地路径 → data URL；URL / data URL 原样返回 */
const toMediaUrl = (src: string): string => {
	if (isUrl(src)) return src;
	const path = abs(src);
	if (!existsSync(path)) throw new Error(`媒体文件不存在：${path}`);
	const ext = extname(path).toLowerCase();
	const mime =
		ext === ".png"
			? "image/png"
			: ext === ".webp"
				? "image/webp"
				: ext === ".gif"
					? "image/gif"
					: ext === ".mp4"
						? "video/mp4"
						: ext === ".webm"
							? "video/webm"
							: ext === ".wav"
								? "audio/wav"
								: ext === ".mp3"
									? "audio/mpeg"
									: "image/jpeg";
	return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
};

const parseCmdArgs = (raw: string, keys: string[]) => {
	const opts: Record<string, string> = {};
	const parts: string[] = [];
	for (const tok of raw.split(/\s+/).filter(Boolean)) {
		const m = tok.match(/^([a-z_]+)=(.+)$/);
		if (m && keys.includes(m[1]!)) opts[m[1]!] = m[2]!;
		else parts.push(tok);
	}
	return { prompt: parts.join(" "), opts };
};

const isH3 = (m: string) => m === H3;

async function createTask(
	apiKey: string,
	body: Record<string, unknown>,
	model: string,
	signal?: AbortSignal,
): Promise<string> {
	const url = isH3(model) ? `${BASE}/v2/video_generation` : `${BASE}/v1/video_generation`;
	const res = await fetch(url, {
		method: "POST",
		headers: authHeaders(apiKey),
		body: JSON.stringify(body),
		signal,
	});
	const text = await res.text();
	let data: CreateResp;
	try {
		data = JSON.parse(text) as CreateResp;
	} catch {
		throw new Error(`创建任务失败 HTTP ${res.status}：${text.slice(0, 300)}`);
	}
	if (!res.ok) {
		const msg = data.error?.message ?? text.slice(0, 300);
		throw new Error(`创建任务失败 HTTP ${res.status}：${msg}`);
	}
	assertOk(data.base_resp);
	if (!data.task_id) throw new Error(`创建任务无 task_id：${text.slice(0, 200)}`);
	return data.task_id;
}

async function pollUntilReady(
	apiKey: string,
	taskId: string,
	model: string,
	opts: {
		timeoutS: number;
		pollMs: number;
		signal?: AbortSignal;
		onStatus?: (s: string) => void;
	},
): Promise<{ downloadUrl: string; meta: Record<string, unknown> }> {
	const deadline = Date.now() + opts.timeoutS * 1000;
	const headers = { Authorization: `Bearer ${apiKey}` };

	while (true) {
		if (opts.signal?.aborted) throw new Error("aborted");
		if (Date.now() > deadline) throw new Error(`轮询超时（${opts.timeoutS}s），task_id=${taskId}`);

		if (isH3(model)) {
			const res = await fetch(`${BASE}/v2/query/video_generation/${taskId}`, { headers, signal: opts.signal });
			const data = (await res.json()) as V2Query;
			if (!res.ok) throw new Error(`查询失败 HTTP ${res.status}：${JSON.stringify(data).slice(0, 200)}`);
			const task = data.task;
			const status = task?.status ?? "unknown";
			opts.onStatus?.(status);
			if (status === "succeeded") {
				const url = task?.content?.url;
				if (!url) throw new Error(`成功但无下载地址：${JSON.stringify(data).slice(0, 200)}`);
				return {
					downloadUrl: url,
					meta: {
						resolution: task?.resolution,
						duration: task?.duration,
						ratio: task?.ratio,
					},
				};
			}
			if (status === "failed" || status === "cancelled") {
				throw new Error(`任务${status}：${JSON.stringify(task?.error ?? data).slice(0, 300)}`);
			}
		} else {
			const res = await fetch(`${BASE}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
				headers,
				signal: opts.signal,
			});
			const data = (await res.json()) as V1Query;
			if (!res.ok) throw new Error(`查询失败 HTTP ${res.status}：${JSON.stringify(data).slice(0, 200)}`);
			assertOk(data.base_resp);
			const status = data.status ?? "unknown";
			opts.onStatus?.(status);
			if (status === "Success") {
				if (data.file_id == null) throw new Error(`成功但无 file_id：${JSON.stringify(data).slice(0, 200)}`);
				const fr = await fetch(`${BASE}/v1/files/retrieve?file_id=${data.file_id}`, {
					headers,
					signal: opts.signal,
				});
				const fileData = (await fr.json()) as FileResp;
				if (!fr.ok) throw new Error(`取文件失败 HTTP ${fr.status}`);
				assertOk(fileData.base_resp);
				const url = fileData.file?.download_url;
				if (!url) throw new Error(`无 download_url：${JSON.stringify(fileData).slice(0, 200)}`);
				return {
					downloadUrl: url.startsWith("http") ? url : `https://${url}`,
					meta: {
						file_id: data.file_id,
						video_width: data.video_width,
						video_height: data.video_height,
						filename: fileData.file?.filename,
					},
				};
			}
			if (status === "Fail") throw new Error(`任务失败：${JSON.stringify(data).slice(0, 300)}`);
		}

		await sleep(opts.pollMs, opts.signal);
	}
}

async function downloadVideo(url: string, saveTo: string, signal?: AbortSignal): Promise<string> {
	const path = abs(saveTo.endsWith(".mp4") ? saveTo : `${saveTo}.mp4`);
	mkdirSync(dirname(path), { recursive: true });
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
	writeFileSync(path, Buffer.from(await res.arrayBuffer()));
	return path;
}

/** 按模型/分辨率校正 duration、resolution，避免 2013 invalid params */
function normalizeMedia(model: Model, duration?: number, resolution?: Resolution) {
	if (isH3(model)) {
		const res: Resolution = resolution === "2K" || resolution === "768P" ? resolution : "768P";
		const d = duration ?? 5;
		return { duration: Math.min(15, Math.max(4, Math.round(d))), resolution: res };
	}

	// Hailuo-2.3 / 02：768P→6|10；1080P→仅6。其余旧模型仅 6s/720P
	const hailuoFlex = model === "MiniMax-Hailuo-2.3" || model === "MiniMax-Hailuo-2.3-Fast" || model === "MiniMax-Hailuo-02";
	let res: Resolution = resolution ?? (hailuoFlex ? "768P" : "720P");
	if (hailuoFlex) {
		if (res !== "768P" && res !== "1080P") res = "768P";
	} else if (res !== "720P" && res !== "1080P") {
		res = "720P";
	}

	let d = duration ?? 6;
	if (res === "1080P" || !hailuoFlex) d = 6;
	else d = d >= 8 ? 10 : 6; // 非法值就近到 6/10

	return { duration: d, resolution: res };
}

function buildBody(params: {
	prompt: string;
	model: Model;
	duration?: number;
	resolution?: Resolution;
	ratio?: Ratio;
	first_frame?: string;
	last_frame?: string;
	reference_image?: string;
	prompt_optimizer?: boolean;
	aigc_watermark?: boolean;
}): Record<string, unknown> {
	const { prompt, model } = params;
	const { duration, resolution } = normalizeMedia(model, params.duration, params.resolution);

	if (isH3(model)) {
		const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
		if (params.first_frame) {
			content.push({
				type: "image_url",
				image_url: { url: toMediaUrl(params.first_frame) },
				role: "first_frame",
			});
		}
		if (params.last_frame) {
			content.push({
				type: "image_url",
				image_url: { url: toMediaUrl(params.last_frame) },
				role: "last_frame",
			});
		}
		if (params.reference_image) {
			content.push({
				type: "image_url",
				image_url: { url: toMediaUrl(params.reference_image) },
				role: "reference_image",
			});
		}
		const body: Record<string, unknown> = { model, content, duration, resolution };
		// 文生视频 ratio 必填且不能 adaptive；有首帧时由图片决定
		const hasFrame = !!(params.first_frame || params.last_frame || params.reference_image);
		if (!hasFrame) body.ratio = params.ratio && params.ratio !== "adaptive" ? params.ratio : "16:9";
		else if (params.ratio) body.ratio = params.ratio;
		if (params.aigc_watermark !== undefined) body.aigc_watermark = params.aigc_watermark;
		return body;
	}

	// v1 Hailuo
	const body: Record<string, unknown> = { model, prompt, duration, resolution };
	if (params.first_frame) body.first_frame_image = toMediaUrl(params.first_frame);
	if (params.last_frame) body.last_frame_image = toMediaUrl(params.last_frame);
	if (params.prompt_optimizer !== undefined) body.prompt_optimizer = params.prompt_optimizer;
	if (params.aigc_watermark !== undefined) body.aigc_watermark = params.aigc_watermark;
	return body;
}

const Params = Type.Object({
	prompt: Type.String({ description: "视频描述提示词（英文更稳；H3 ≤7000 字，Hailuo ≤2000）" }),
	model: Type.Optional(StringEnum([...MODELS], { description: `模型，默认 ${DEFAULT_MODEL}（H3 需 ent 套餐）` })),
	duration: Type.Optional(
		Type.Integer({
			minimum: 4,
			maximum: 15,
			description: "时长秒；Hailuo 仅 6/10（1080P 仅 6），非法值自动校正；H3 4–15",
		}),
	),
	resolution: Type.Optional(StringEnum([...RESOLUTIONS], { description: "分辨率；H3: 768P/2K；Hailuo: 720P/768P/1080P" })),
	ratio: Type.Optional(StringEnum([...RATIOS], { description: "宽高比（H3 文生视频必填，默认 16:9）" })),
	first_frame: Type.Optional(Type.String({ description: "首帧图：本地路径 / URL / data URL" })),
	last_frame: Type.Optional(Type.String({ description: "尾帧图：本地路径 / URL / data URL" })),
	reference_image: Type.Optional(Type.String({ description: "参考主体图（H3 reference 模式）" })),
	prompt_optimizer: Type.Optional(Type.Boolean({ description: "Hailuo：是否优化 prompt，默认 true" })),
	aigc_watermark: Type.Optional(Type.Boolean({ description: "是否加水印，默认 false" })),
	save_to: Type.Optional(Type.String({ description: "保存路径，默认 ./minimax-video-<ts>.mp4" })),
	timeout_s: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600, description: `轮询超时秒，默认 ${DEFAULT_TIMEOUT_S}` })),
});

type ToolParams = {
	prompt: string;
	model?: Model;
	duration?: number;
	resolution?: Resolution;
	ratio?: Ratio;
	first_frame?: string;
	last_frame?: string;
	reference_image?: string;
	prompt_optimizer?: boolean;
	aigc_watermark?: boolean;
	save_to?: string;
	timeout_s?: number;
};

export async function runGenerate(
	params: ToolParams,
	signal: AbortSignal | undefined,
	onUpdate?: (msg: string) => void,
) {
	const started = Date.now();
	const apiKey = loadApiKey();
	const model: Model = params.model ?? DEFAULT_MODEL;
	const timeoutS = params.timeout_s ?? DEFAULT_TIMEOUT_S;
	const body = buildBody({ ...params, model });

	onUpdate?.(`→ ${model}：提交任务…`);
	const taskId = await createTask(apiKey, body, model, signal);
	onUpdate?.(`task_id=${taskId}，轮询中…`);

	const { downloadUrl, meta } = await pollUntilReady(apiKey, taskId, model, {
		timeoutS,
		pollMs: POLL_MS,
		signal,
		onStatus: (s) => {
			const sec = ((Date.now() - started) / 1000).toFixed(0);
			onUpdate?.(`task_id=${taskId} · ${s} · ${sec}s`);
		},
	});

	const saveTo = params.save_to ?? `minimax-video-${Date.now()}.mp4`;
	onUpdate?.(`下载中…`);
	const path = await downloadVideo(downloadUrl, saveTo, signal);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);

	return { path, taskId, model, meta, seconds };
}

export default function minimaxVideoGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "video_minimax",
		label: "MiniMax Video Generate",
		description:
			"通过 auth.json 中 minimax-cn 的 api_key 调用 MiniMax 视频生成（默认 MiniMax-Hailuo-2.3 /v1；H3 走 /v2，需 ent 套餐）。支持文生视频、首/尾帧、参考图；异步轮询后落盘 mp4。",
		promptSnippet: "Generate a video via MiniMax Hailuo or H3 (text/image-to-video), poll async task, save mp4",
		promptGuidelines: [
			"使用 video_minimax 时英文 prompt 更稳；可用 [Push in]/[Pan left] 等运镜指令。",
			"默认 MiniMax-Hailuo-2.3；账户支持时再用 MiniMax-H3。",
			"视频生成较慢（数分钟），勿重复提交同一任务。",
		],
		parameters: Params,
		async execute(_id, params, signal, onUpdate) {
			const p = params as ToolParams;
			const result = await runGenerate(p, signal, (msg) => {
				onUpdate?.({ content: [{ type: "text", text: msg }] });
			});

			const summary =
				`✅ ${result.path}\n` +
				`model：${result.model}；task_id：${result.taskId}；用时：${result.seconds}s` +
				(result.meta.resolution ? `；resolution：${result.meta.resolution}` : "") +
				(result.meta.duration != null ? `；duration：${result.meta.duration}s` : "") +
				(result.meta.ratio ? `；ratio：${result.meta.ratio}` : "") +
				(result.meta.video_width
					? `；size：${result.meta.video_width}x${result.meta.video_height}`
					: "");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					path: result.path,
					task_id: result.taskId,
					model: result.model,
					...result.meta,
					seconds: Number(result.seconds),
				},
			};
		},
	});

	pi.registerCommand("video-minimax", {
		description:
			"快速生成视频，用法 /video-minimax <prompt> [model=.. duration=.. resolution=.. ratio=.. first_frame=.. save_to=..]",
		handler: async (args, ctx) => {
			const keys = [
				"model",
				"duration",
				"resolution",
				"ratio",
				"first_frame",
				"last_frame",
				"reference_image",
				"prompt_optimizer",
				"aigc_watermark",
				"save_to",
				"timeout_s",
			];
			const { prompt, opts } = parseCmdArgs(args.trim(), keys);
			if (!prompt) {
				ctx.ui.notify(
					"用法：/video-minimax <prompt> [model=.. duration=.. resolution=.. ratio=.. first_frame=.. save_to=..]",
					"warning",
				);
				return;
			}

			const key = "video-minimax";
			const started = Date.now();
			const tick = (extra = "") =>
				ctx.ui.setStatus(key, `生成中…${((Date.now() - started) / 1000).toFixed(0)}s${extra ? ` · ${extra}` : ""}`);
			tick();

			try {
				const result = await runGenerate(
					{
						prompt,
						model: (opts.model as Model) || undefined,
						duration: opts.duration ? parseInt(opts.duration, 10) : undefined,
						resolution: (opts.resolution as Resolution) || undefined,
						ratio: (opts.ratio as Ratio) || undefined,
						first_frame: opts.first_frame,
						last_frame: opts.last_frame,
						reference_image: opts.reference_image,
						prompt_optimizer:
							opts.prompt_optimizer === undefined ? undefined : opts.prompt_optimizer === "true",
						aigc_watermark:
							opts.aigc_watermark === undefined ? undefined : opts.aigc_watermark === "true",
						save_to: opts.save_to,
						timeout_s: opts.timeout_s ? parseInt(opts.timeout_s, 10) : undefined,
					},
					undefined,
					(msg) => tick(msg),
				);
				ctx.ui.notify(`✓ ${result.path}（${result.seconds}s，${basename(result.path)}）`, "info");
			} catch (err) {
				ctx.ui.notify(`video-minimax 失败：${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				ctx.ui.setStatus(key, undefined);
			}
		},
	});
}
