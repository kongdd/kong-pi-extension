/**
 * Friday — pi 语音助手
 *
 * 命令：
 *   /friday on   开启语音播报
 *   /friday off  关闭语音播报并清空待播内容
 *   /friday zh   使用中文音色
 *   /friday en   使用英文音色
 *   /friday      查看状态
 *
 * TUI 模式通过 edge-tts 播放本地音频；RPC 模式（包括 pi-web）发出标准
 * Extension UI setWidget 事件，由浏览器的 Web Speech API 播放。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "friday";
const BROWSER_SPEECH_WIDGET = "friday-speech";
const VOICES = {
  zh: "zh-CN-XiaoxiaoNeural",
  en: "en-US-AriaNeural",
} as const;
const PLAYERS = ["mpv", "ffplay", "mplayer"] as const;

type VoiceMode = keyof typeof VOICES;
type Player = (typeof PLAYERS)[number];
type BrowserSpeechCommand = {
  id: number;
  action: "speak" | "stop";
  text?: string;
  lang?: string;
};

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";

  return candidate.content
    .filter((part): part is { type: "text"; text: string } => (
      !!part
      && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** 提取标题、要点和结论，生成适合听取的短摘要。 */
function summarizeForSpeech(text: string, maxChars = 360): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#]/g, "")
    .replace(/\r/g, "")
    .trim();
  if (!cleaned) return "";

  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => line.length <= 80 && !/^[•\-+*\d]/.test(line));
  const bullets = lines
    .filter((line) => /^(?:[-+*•]|\d+[.、])\s*/.test(line))
    .map((line) => line.replace(/^(?:[-+*•]|\d+[.、])\s*/, ""));
  const prose = lines.filter((line) => !/^(?:[-+*•]|\d+[.、])\s*/.test(line)).join(" ");
  const sentences = prose.match(/[^。！？!?]+[。！？!?]?/g) ?? [prose];

  const parts: string[] = [];
  if (heading && heading !== sentences[0]) parts.push(heading);
  if (bullets.length) parts.push(...bullets.slice(0, 3));
  else parts.push(...sentences.slice(0, 3));

  const summary = parts.join("。 ").replace(/\s+/g, " ").trim();
  return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 1)}…`;
}

function waitForExit(process: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    process.once("error", () => resolve(null));
    process.once("close", (code) => resolve(code));
  });
}

function stopProcess(process: ChildProcess | undefined): void {
  if (process && !process.killed) process.kill("SIGTERM");
}

function playerArgs(program: Player, file: string): string[] {
  if (program === "ffplay") return ["-nodisp", "-autoexit", "-loglevel", "error", file];
  if (program === "mpv") return ["--no-video", "--really-quiet", file];
  return ["-really-quiet", file];
}

export default function friday(pi: ExtensionAPI): void {
  // Factory may be reused by multiple AgentSession instances; all mutable state must be per instance.
  let enabled = false;
  let voiceMode: VoiceMode = "zh";
  let player: Player | undefined;
  let speaking = false;
  let currentTts: ChildProcess | undefined;
  let currentPlayer: ChildProcess | undefined;
  let speechQueue: string[] = [];
  let drainingQueue = false;
  let lastAssistantText = "";
  let cancellationGeneration = 0;
  let browserCommandId = 0;

  function renderStatus(ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } }): void {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, "○ Friday off");
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, speaking ? "◉ Friday speaking" : `● Friday ${voiceMode}`);
  }

  async function hasEdgeTts(): Promise<boolean> {
    const result = await pi.exec("uvx", ["edge-tts", "--version"], { timeout: 5000 });
    return result.code === 0;
  }

  async function findPlayer(): Promise<Player | undefined> {
    for (const candidate of PLAYERS) {
      const result = await pi.exec("sh", ["-lc", `command -v ${candidate}`], { timeout: 2000 });
      if (result.code === 0) return candidate;
    }
    return undefined;
  }

  function stopLocalSpeech(): void {
    cancellationGeneration++;
    speechQueue = [];
    stopProcess(currentTts);
    stopProcess(currentPlayer);
    currentTts = undefined;
    currentPlayer = undefined;
    speaking = false;
  }

  async function playLocalSpeech(text: string, generation: number): Promise<void> {
    if (!player || generation !== cancellationGeneration) return;
    const output = join(tmpdir(), `friday-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
    const tts = spawn("uvx", ["edge-tts", "--text", text, "--write-media", output, "--voice", VOICES[voiceMode]], {
      stdio: "ignore",
    });
    currentTts = tts;

    try {
      if (await waitForExit(tts) !== 0 || !enabled || generation !== cancellationGeneration) return;
      const audioPlayer = spawn(player, playerArgs(player, output), { stdio: "ignore" });
      currentPlayer = audioPlayer;
      await waitForExit(audioPlayer);
    } finally {
      if (currentTts === tts) currentTts = undefined;
      currentPlayer = undefined;
      await rm(output, { force: true }).catch(() => {});
    }
  }

  function enqueueLocalSpeech(
    text: string,
    ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } },
  ): void {
    speechQueue.push(text);
    if (drainingQueue) return;

    drainingQueue = true;
    void (async () => {
      while (enabled && speechQueue.length > 0) {
        const next = speechQueue.shift();
        if (!next) continue;
        speaking = true;
        renderStatus(ctx);
        await playLocalSpeech(next, cancellationGeneration);
      }
      speaking = false;
      drainingQueue = false;
      renderStatus(ctx);
    })();
  }

  function emitBrowserSpeech(
    ctx: { ui: { setWidget(key: string, lines: string[] | undefined): void } },
    command: Omit<BrowserSpeechCommand, "id">,
  ): void {
    // setWidget 是状态协议，不是瞬时事件协议。保留最新指令以保证 SSE 重连后
    // 仍可送达，并用单调 id 让浏览器过滤状态同步造成的重复播放。
    ctx.ui.setWidget(BROWSER_SPEECH_WIDGET, [JSON.stringify({
      id: ++browserCommandId,
      ...command,
    })]);
  }

  pi.on("agent_start", () => {
    lastAssistantText = "";
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistantText = extractAssistantText(event.message);
  });

  // agent_settled 表示这一轮没有待执行工具、重试或 follow-up；只播报最终回答。
  pi.on("agent_settled", (_event, ctx) => {
    if (!enabled || !lastAssistantText) return;
    const summary = summarizeForSpeech(lastAssistantText);
    if (!summary) return;

    if (ctx.mode === "rpc") {
      emitBrowserSpeech(ctx, {
        action: "speak",
        text: summary,
        lang: voiceMode === "zh" ? "zh-CN" : "en-US",
      });
      return;
    }
    enqueueLocalSpeech(summary, ctx);
  });

  pi.registerCommand("friday", {
    description: "Friday 语音助手：/friday on|off|zh|en",
    getArgumentCompletions(prefix) {
      const value = prefix.trim().toLowerCase();
      return ["on", "off", "zh", "en"]
        .filter((item) => item.startsWith(value))
        .map((item) => ({ value: item, label: item }));
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "on") {
        if (ctx.mode !== "rpc") {
          const [ttsAvailable, availablePlayer] = await Promise.all([hasEdgeTts(), findPlayer()]);
          if (!ttsAvailable || !availablePlayer) {
            ctx.ui.notify(
              `Friday 无法开启：${!ttsAvailable ? "未找到 uvx edge-tts" : ""}${!ttsAvailable && !availablePlayer ? "；" : ""}${!availablePlayer ? "未找到 mpv、ffplay 或 mplayer" : ""}`,
              "error",
            );
            return;
          }
          player = availablePlayer;
        }
        enabled = true;
        renderStatus(ctx);
        ctx.ui.notify(ctx.mode === "rpc" ? "Friday 已开启：Pi-Web 将使用浏览器语音播放。" : `Friday 已开启：本地播放器为 ${player}。`, "info");
        return;
      }

      if (command === "off") {
        enabled = false;
        stopLocalSpeech();
        if (ctx.mode === "rpc") emitBrowserSpeech(ctx, { action: "stop" });
        renderStatus(ctx);
        ctx.ui.notify("Friday 已关闭。", "info");
        return;
      }

      if (command === "zh" || command === "en") {
        voiceMode = command;
        renderStatus(ctx);
        ctx.ui.notify(`Friday 已切换为${command === "zh" ? "中文" : "英文"}音色。`, "info");
        return;
      }

      ctx.ui.notify(
        `Friday 语音助手\n  状态：${enabled ? "开启" : "关闭"}\n  音色：${VOICES[voiceMode]}\n  模式：${ctx.mode === "rpc" ? "浏览器语音" : "本地 edge-tts"}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    renderStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopLocalSpeech();
    if (ctx.mode === "rpc") {
      emitBrowserSpeech(ctx, { action: "stop" });
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
