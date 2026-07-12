/**
 * Minimal web fetch extension for pi.
 *
 * Tools:
 * - web_fetch: fetch a web page and return readable text
 *
 * Notes:
 * - Earlier revisions exposed a `web_search` tool backed by Google Custom
 *   Search or Bing RSS. Google CSE requires API keys you don't ship with
 *   pi; Bing RSS has since stopped returning real search results and now
 *   serves an ad/editorial feed. Both backends were removed on 2026-07-11.
 * - For semantic / unknown-URL discovery, use the built-in `exa_search`
 *   tool or the `exa-search` skill instead.
 * - Tool output is truncated to pi's default 50KB / 2000 lines limit.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface WebFetchDetails {
	url: string;
	status: number;
	contentType: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

const HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
			if (entity[0] === "#") {
				const raw = entity[1]?.toLowerCase() === "x" ? entity.slice(2) : entity.slice(1);
				const code = parseInt(raw, entity[1]?.toLowerCase() === "x" ? 16 : 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : match;
			}
			return HTML_ENTITIES[entity] ?? match;
		});
}

function stripTags(html: string): string {
	return decodeEntities(
		html
			.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t\r\f\v]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	);
}

async function truncateForTool(text: string, tempPrefix: string) {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text };

	const dir = await mkdtemp(join(tmpdir(), tempPrefix));
	const fullOutputPath = join(dir, "output.txt");
	await writeFile(fullOutputPath, text, "utf8");

	return {
		text: `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`,
		truncation,
		fullOutputPath,
	};
}

function looksLikeHtml(contentType: string, body: string): boolean {
	return contentType.includes("text/html") || /<html[\s>]/i.test(body) || /<body[\s>]/i.test(body);
}

async function fetchWebPage(urlText: string, signal?: AbortSignal): Promise<{ text: string; details: WebFetchDetails }> {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		throw new Error(`Invalid URL: ${urlText}`);
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("Only http:// and https:// URLs are supported");
	}

	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; pi-web-fetch/1.0)",
			Accept: "text/html, text/plain, application/xhtml+xml, */*;q=0.8",
		},
	});

	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();
	const readable = looksLikeHtml(contentType, body) ? stripTags(body) : body.trim();
	const output = await truncateForTool(
		[`URL: ${url.toString()}`, `Status: ${response.status}`, `Content-Type: ${contentType || "unknown"}`, "", readable].join("\n"),
		"pi-web-fetch-",
	);

	return {
		text: output.text,
		details: {
			url: url.toString(),
			status: response.status,
			contentType,
			truncation: output.truncation,
			fullOutputPath: output.fullOutputPath,
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a public web page and return readable text. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Fetch a public URL and return readable page text.",
		promptGuidelines: [
			"Use web_fetch to read URLs found by exa_search or supplied by the user.",
			"Use web_fetch only for public http:// or https:// URLs.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Public http:// or https:// URL to fetch" }),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await fetchWebPage(params.url, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("web_fetch "))}${theme.fg("accent", args.url ?? "")}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching page..."), 0, 0);
			const details = result.details as WebFetchDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No fetch details"), 0, 0);
			let text = theme.fg(details.status >= 200 && details.status < 400 ? "success" : "warning", `HTTP ${details.status}`);
			text += theme.fg("dim", ` ${details.contentType || "unknown"}`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			return new Text(text, 0, 0);
		},
	});
}