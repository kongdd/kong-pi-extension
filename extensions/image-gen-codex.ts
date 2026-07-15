/**
 * Codex Image Generation — pi extension
 *
 * 只做一件事：复用 `codex login` 的 ChatGPT OAuth token，
 * 注册 `image_codex` 工具并调用 `/v1/images/generations`。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { arch, homedir, platform, release } from "node:os";

const CODEX_HOME = process.env.COHOME ?? join(homedir(), ".codex");
const ORIGINATOR = "codex_cli_rs";
const MODEL = "gpt-image-2";
const QUALITY = ["low", "medium", "high", "auto"] as const;
const SIZE = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
const RETRY_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

type Quality = (typeof QUALITY)[number];
type Size = (typeof SIZE)[number];

type Auth = {
	token: string;
	accountId?: string;
	email?: string;
	plan?: string;
};

type Runtime = {
	baseUrl: string;
	version: string;
	auth: Auth;
};

type ImageResponse = {
	data: Array<{ b64_json?: string; revised_prompt?: string }>;
	size?: string;
	quality?: string;
};

const textIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf-8") : undefined);
const abs = (path: string) => (isAbsolute(path) ? path : resolve(process.cwd(), path));
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const decodeBase64Url = (value: string) =>
	Buffer.from(
		value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4),
		"base64",
	);

const jwtPayload = (token: string): Record<string, unknown> => {
	const payload = token.split(".")[1];
	if (!payload) return {};
	try {
		return JSON.parse(decodeBase64Url(payload).toString("utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
};

const loadAuth = (): Auth => {
	const raw = textIfExists(join(CODEX_HOME, "auth.json"));
	if (!raw) throw new Error("Codex 认证不可用：请先运行 `codex login` 登录 ChatGPT");

	const authJson = JSON.parse(raw) as {
		auth_mode?: string;
		tokens?: { access_token?: string; account_id?: string };
	};
	const token = authJson.tokens?.access_token;
	if (authJson.auth_mode !== "chatgpt" || !token) {
		throw new Error("Codex 认证不可用：请先运行 `codex login` 登录 ChatGPT");
	}

	const claims = jwtPayload(token);
	const expMs = typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
	if (expMs && expMs <= Date.now()) throw new Error("Codex 认证已过期：请重新运行 `codex login`");

	const account = (claims["https://api.openai.com/auth"] as Record<string, unknown>) ?? {};
	const profile = (claims["https://api.openai.com/profile"] as Record<string, unknown>) ?? {};

	return {
		token,
		accountId: authJson.tokens?.account_id ?? str(account.chatgpt_account_id),
		email: str(profile.email),
		plan: str(account.chatgpt_plan_type),
	};
};

const codexVersion = (): string => {
	const t = textIfExists(join(CODEX_HOME, "version.json"));
	return t ? str(JSON.parse(t).latest_version) ?? "0.0.0" : "0.0.0";
};

const userAgent = (v: string) =>
	`${ORIGINATOR}/${v} (${platform()} ${release()}; ${arch()}) terminal/${process.env.TERM ?? "unknown"}`;

const loadRuntime = (): Runtime => {
	const config = textIfExists(join(CODEX_HOME, "config.toml"));
	const baseUrl = config?.match(/^\s*openai_base_url\s*=\s*"([^"]+)"/m)?.[1] ?? "https://api.openai.com/v1";
	return { baseUrl: baseUrl.replace(/\/$/, ""), version: codexVersion(), auth: loadAuth() };
};

const headers = ({ auth, version }: Runtime): Record<string, string> => ({
	version,
	authorization: `Bearer ${auth.token}`,
	...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
	accept: "*/*",
	originator: ORIGINATOR,
	"user-agent": userAgent(version),
	"content-type": "application/json",
});

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const generateImage = async (
	rt: Runtime,
	body: { prompt: string; quality?: Quality; size?: Size; n: 1; background: "auto"; model: typeof MODEL },
	signal?: AbortSignal,
): Promise<ImageResponse> => {
	const url = `${rt.baseUrl}/images/generations`;

	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(url, { method: "POST", headers: headers(rt), body: JSON.stringify(body), signal });
			if (res.ok) return (await res.json()) as ImageResponse;
			throw new HttpError(res.status, (await res.text().catch(() => "")).slice(0, 500));
		} catch (err) {
			if (!(err instanceof HttpError) || !RETRY_HTTP.has(err.status) || attempt === 3) throw err;
			await sleep(800 * attempt);
		}
	}
	throw new Error("unreachable");
};

const saveImage = (b64: string, saveTo?: string) => {
	const path = abs(saveTo ?? `codex-image-${Date.now()}.png`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
	return path;
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
	prompt: Type.String({ description: "图像生成提示词（英文最佳）" }),
	save_to: Type.Optional(Type.String({ description: "保存路径（绝对或相对 cwd），默认 ./codex-image-<timestamp>.png" })),
	size: Type.Optional(StringEnum(SIZE)),
	quality: Type.Optional(StringEnum(QUALITY)),
});

export default function codexImageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "image_codex",
		label: "Codex Image Generate",
		description: "通过 Codex ChatGPT 认证调用 gpt-image-2 生图（无需 OPENAI_API_KEY），默认保存到当前工作目录。",
		promptSnippet: "Generate an image from a text prompt via Codex auth (gpt-image-2)",
		promptGuidelines: ["使用 image_codex 时用英文提示词效果最佳。"],
		parameters: Params,
		async execute(_id, params, signal, onUpdate) {
			const started = Date.now();
			const rt = loadRuntime();
			onUpdate?.({ content: [{ type: "text", text: `→ ${MODEL}：提交生成任务…` }] });

			const response = await generateImage(
				rt,
				{
					model: MODEL,
					prompt: params.prompt,
					background: "auto",
					quality: params.quality,
					size: params.size,
					n: 1,
				},
				signal,
			);

			const item = response.data?.[0];
			if (!item?.b64_json) throw new Error(`图像响应为空：${JSON.stringify(response).slice(0, 200)}`);

			const path = saveImage(item.b64_json, params.save_to);
			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			onUpdate?.({ content: [{ type: "text", text: `✓ 已保存 ${path}（${seconds}s）` }] });

			return {
				content: [
					{
						type: "text",
						text:
							`✅ ${path}\n` +
							`size：${response.size ?? params.size ?? "auto"}；quality：${response.quality ?? params.quality ?? "auto"}` +
							(item.revised_prompt ? `\nrevised_prompt：${item.revised_prompt}` : ""),
					},
				],
				details: {
					path,
					model: MODEL,
					size: response.size ?? params.size,
					quality: response.quality ?? params.quality,
					revised_prompt: item.revised_prompt,
					account: rt.auth.email ?? rt.auth.accountId,
					plan: rt.auth.plan,
				},
			};
		},
	});

	// 快速生图命令：/codex-image <prompt> [size=.. quality=.. save_to=..]
	pi.registerCommand("image-codex", {
		description: "快速生图（gpt-image-2），用法 /image-codex <prompt> [size=.. quality=.. save_to=..]",
		handler: async (args, ctx) => {
			const { prompt, opts } = parseCmdArgs(args.trim(), ["size", "quality", "save_to"]);
			if (!prompt) {
				ctx.ui.notify("用法：/image-codex <prompt> [size=.. quality=.. save_to=..]", "warning");
				return;
			}
			const started = Date.now();
			const key = "image-codex";
			const tick = () => ctx.ui.setStatus(key, `生成中…已用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
			tick();
			const timer = setInterval(tick, 500);
			try {
				const rt = loadRuntime();
				const response = await generateImage(rt, {
					model: MODEL,
					prompt,
					background: "auto",
					quality: opts.quality as Quality | undefined,
					size: opts.size as Size | undefined,
					n: 1,
				});
				const item = response.data?.[0];
				if (!item?.b64_json) throw new Error(`图像响应为空：${JSON.stringify(response).slice(0, 200)}`);
				const path = saveImage(item.b64_json, opts.save_to);
				const seconds = ((Date.now() - started) / 1000).toFixed(1);
				ctx.ui.notify(`✓ ${path}（${seconds}s）`, "info");
			} catch (err) {
				ctx.ui.notify(`image-codex 失败：${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				clearInterval(timer);
				ctx.ui.setStatus(key, undefined);
			}
		},
	});
}
