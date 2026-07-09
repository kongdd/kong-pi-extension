/**
 * Minimal web search extension for pi.
 *
 * Tools:
 * - web_search: search the web via Google Custom Search when configured, otherwise Bing RSS
 * - web_fetch: fetch a web page and return readable text
 *
 * Notes:
 * - Google requires GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX (or GOOGLE_CSE_ID).
 * - Without Google configuration, search falls back to Bing RSS.
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

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

type SearchBackend = "auto" | "google" | "bing";
type ResolvedSearchBackend = "google-cse" | "bing-rss";

interface WebSearchDetails {
	query: string;
	backend: ResolvedSearchBackend;
	resultCount: number;
	results: SearchResult[];
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

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

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

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

function getXmlTag(block: string, tag: string): string {
	const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
	return match ? stripTags(match[1] ?? "") : "";
}

function parseBingRss(xml: string, maxResults: number): SearchResult[] {
	const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
	return items.slice(0, maxResults).map((item) => {
		const block = item[1] ?? "";
		return {
			title: getXmlTag(block, "title"),
			url: getXmlTag(block, "link"),
			snippet: getXmlTag(block, "description"),
		};
	});
}

function searchEngineLabel(backend: ResolvedSearchBackend): string {
	return backend === "google-cse" ? "Google Custom Search" : "Bing RSS";
}

function formatSearchResults(query: string, backend: ResolvedSearchBackend, results: SearchResult[]): string {
	const lines = [`Search engine: ${searchEngineLabel(backend)}`, `Web search results for: ${query}`, ""];
	if (results.length === 0) return lines.concat(["No web results found."]).join("\n");
	for (const [index, result] of results.entries()) {
		lines.push(`${index + 1}. ${result.title || "(untitled)"}`);
		lines.push(`URL: ${result.url}`);
		if (result.snippet) lines.push(`Snippet: ${result.snippet}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
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

function getGoogleConfig() {
	const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
	const cx = process.env.GOOGLE_SEARCH_CX ?? process.env.GOOGLE_CSE_ID ?? process.env.GOOGLE_SEARCH_ENGINE_ID;
	return apiKey && cx ? { apiKey, cx } : undefined;
}

function normalizeBackend(value: unknown): SearchBackend {
	if (value === "google" || value === "bing" || value === "auto") return value;
	return "auto";
}

async function buildSearchResult(
	query: string,
	backend: ResolvedSearchBackend,
	results: SearchResult[],
): Promise<{ text: string; details: WebSearchDetails }> {
	const output = await truncateForTool(formatSearchResults(query, backend, results), "pi-web-search-");

	return {
		text: output.text,
		details: {
			query,
			backend,
			resultCount: results.length,
			results,
			truncation: output.truncation,
			fullOutputPath: output.fullOutputPath,
		},
	};
}

async function searchBing(query: string, maxResults: number, signal?: AbortSignal) {
	const url = new URL("https://www.bing.com/search");
	url.searchParams.set("format", "rss");
	url.searchParams.set("q", query);

	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; pi-web-search/1.0)",
			Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
		},
	});

	if (!response.ok) throw new Error(`Bing RSS search failed: HTTP ${response.status}`);

	const xml = await response.text();
	return buildSearchResult(query, "bing-rss", parseBingRss(xml, maxResults));
}

async function searchGoogle(query: string, maxResults: number, signal?: AbortSignal) {
	const config = getGoogleConfig();
	if (!config) {
		throw new Error("Google search is not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX (or GOOGLE_CSE_ID).");
	}

	const url = new URL("https://www.googleapis.com/customsearch/v1");
	url.searchParams.set("key", config.apiKey);
	url.searchParams.set("cx", config.cx);
	url.searchParams.set("q", query);
	url.searchParams.set("num", String(Math.min(maxResults, 10)));

	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; pi-web-search/1.0)",
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Google Custom Search failed: HTTP ${response.status}\n${body.slice(0, 500)}`);
	}

	const data = await response.json() as {
		items?: Array<{ title?: string; link?: string; snippet?: string }>;
	};
	const results = (data.items ?? []).slice(0, maxResults).map((item) => ({
		title: item.title ?? "",
		url: item.link ?? "",
		snippet: item.snippet ?? "",
	}));

	return buildSearchResult(query, "google-cse", results);
}

async function searchWeb(
	query: string,
	maxResults: number,
	backendInput: unknown = "auto",
	signal?: AbortSignal,
): Promise<{ text: string; details: WebSearchDetails }> {
	const backend = normalizeBackend(backendInput);
	if (backend === "google") return searchGoogle(query, maxResults, signal);
	if (backend === "bing") return searchBing(query, maxResults, signal);
	return getGoogleConfig() ? searchGoogle(query, maxResults, signal) : searchBing(query, maxResults, signal);
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
		name: "web_search",
		label: "Web Search",
		description: `Search the web. Uses Google Custom Search when GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX are configured; otherwise falls back to Bing RSS. Returns titles, URLs, and snippets. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the public web and return titles, URLs, and snippets via Google when configured, otherwise Bing RSS.",
		promptGuidelines: [
			"Use web_search when the user asks to search, look up, research, or verify current public web information.",
			"Do not use web_search for local code search; use grep/find/read instead.",
			"After web_search returns relevant URLs, use web_fetch to read pages when snippets are insufficient.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of results, default 8. Google returns at most 10 per request." })),
			backend: Type.Optional(Type.String({ description: "Search backend: auto, google, or bing. Default auto." })),
		}),
		async execute(_toolCallId, params, signal) {
			const maxResults = clampInteger(params.maxResults, 8, 1, 20);
			const result = await searchWeb(params.query, maxResults, params.backend, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("accent", `"${args.query ?? ""}"`)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching web..."), 0, 0);
			const details = result.details as WebSearchDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No search details"), 0, 0);
			let text = theme.fg("success", `${details.resultCount} result(s) via ${details.backend}`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				for (const [index, item] of details.results.entries()) {
					text += `\n${index + 1}. ${theme.fg("accent", item.title)}\n   ${theme.fg("dim", item.url)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a public web page and return readable text. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Fetch a public URL and return readable page text.",
		promptGuidelines: [
			"Use web_fetch to read URLs found by web_search or supplied by the user.",
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

	pi.registerCommand("web-search", {
		description: "Search the web once and show results: /web-search <query>",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /web-search <query>", "warning");
				return;
			}
			const result = await searchWeb(query, 8, "auto", ctx.signal);
			pi.sendMessage({
				customType: "web-search",
				content: result.text,
				display: true,
				details: result.details,
			});
		},
	});
}
