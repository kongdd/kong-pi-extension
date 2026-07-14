/**
 * Friday — pi 语音助手
 *
 * 命令：
 *   /friday on            开启语音播报
 *   /friday off           关闭语音播报并清空待播内容
 *   /friday zh            使用中文音色
 *   /friday en            使用英文音色
 *   /friday speed <n>     设置语速倍率（0.5–2.0，默认 1.0；不带参数查看当前）
 *   /friday test          测试当前语音通道
 *   /friday               查看状态
 *
 * 本地 TUI 模式直接通过 mpv/ffplay 播放音频；VS Code Remote 模式优先通过
 * `remote.autoForwardPorts` 将 MP3 POST 到本地 friday-receiver（零点击、零授权），
 * 浏览器 SSE 页面作为降级方案。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
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
const REMOTE_SPEECH_HOST = "127.0.0.1";
const REMOTE_SPEECH_PORT = 17321;

const REMOTE_SPEECH_PAGE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Friday Speech</title>
<style>
  body { max-width: 34rem; margin: 12vh auto; padding: 0 1rem; font: 16px system-ui; }
  button { padding: .65rem 1rem; font-size: 1rem; }
  #status { margin-top: 1rem; color: #666; }
</style>
<h1>Friday 语音</h1>
<p>此页面在本地浏览器中播放远程 Pi 的语音。使用期间请保持页面打开。</p>
<button id="enable">启用语音</button>
<div id="status">等待启用</div>
<script>
  const button = document.querySelector('#enable');
  const status = document.querySelector('#status');
  let enabled = false;
  let pending = null;
  let audio = null;
  let lastCommandId = 0;

  function run(command) {
    if (!enabled) { pending = command; return; }
    if (typeof command.id === 'number') {
      // SSE 重连或重放可能推送已处理过的命令；按单调 id 去重避免重复发声。
      if (command.id <= lastCommandId) return;
      lastCommandId = command.id;
    }
    speechSynthesis.cancel();
    if (audio) { audio.pause(); audio = null; }
    if (command.action !== 'speak') return;

    if (command.audio) {
      audio = new Audio(command.audio);
      if (typeof command.rate === 'number' && Number.isFinite(command.rate) && command.rate > 0) {
        audio.playbackRate = command.rate;
      }
      audio.onended = () => { status.textContent = '已连接，等待播报'; };
      audio.onerror = () => { status.textContent = 'MP3 播放失败'; };
      status.textContent = '正在播放 MP3';
      audio.play().catch((error) => {
        status.textContent = '播放被浏览器阻止：' + error.message;
      });
      return;
    }

    if (!command.text) return;
    const utterance = new SpeechSynthesisUtterance(command.text);
    utterance.lang = command.lang || 'zh-CN';
    if (typeof command.rate === 'number' && Number.isFinite(command.rate) && command.rate > 0) {
      utterance.rate = command.rate;
    }
    speechSynthesis.speak(utterance);
    status.textContent = '正在播放系统语音';
    utterance.onend = () => { status.textContent = '已连接，等待播报'; };
    utterance.onerror = (event) => { status.textContent = '系统语音失败：' + event.error; };
  }

  button.onclick = () => {
    enabled = true;
    button.disabled = true;
    button.textContent = '语音已启用';
    status.textContent = '已连接，等待播报';
    if (pending) { const command = pending; pending = null; run(command); }
  };

  const events = new EventSource('/events');
  events.onmessage = (event) => run(JSON.parse(event.data));
  events.onerror = () => { status.textContent = '连接中断，正在重连'; };
</script>
</html>`;

type VoiceMode = keyof typeof VOICES;
type Player = (typeof PLAYERS)[number];
type BrowserSpeechCommand = {
  id: number;
  action: "speak" | "stop";
  text?: string;
  lang?: string;
  audio?: string;
  /** 播放倍率：1 表示原速，1.25 表示 +25%。浏览器侧用于 speechSynthesis.rate 与 audio.playbackRate。 */
  rate?: number;
};

/** 把倍率（如 1.25）转成 edge-tts 的 --rate 字符串（如 "+25%"）。 */
function rateToEdgeTts(rate: number): string {
  const percent = Math.round((rate - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

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
  let speechRate = 1.0;
  let player: Player | undefined;
  let speaking = false;
  let currentTts: ChildProcess | undefined;
  let currentPlayer: ChildProcess | undefined;
  let speechQueue: string[] = [];
  let drainingQueue = false;
  let lastAssistantText = "";
  let cancellationGeneration = 0;
  let browserCommandId = 0;
  let remoteServer: Server | undefined;
  const remoteClients = new Set<ServerResponse>();
  let activeRemoteClient: ServerResponse | undefined;

  // Remote-SSH 与 Remote-WSL 都在远端 Extension Host 中运行。WSL 没有
  // SSH_CONNECTION，因此必须单独识别；FRIDAY_REMOTE 可用于其他远程环境。
  const isVSCodeRemote = Boolean(
    process.env.FRIDAY_REMOTE === "1"
    || (process.env.VSCODE_IPC_HOOK_CLI
      && (process.env.SSH_CONNECTION || process.env.WSL_DISTRO_NAME)),
  );
  // 仅当用户显式配置反向可达的接收器时才主动 POST。默认走远端 SSE，
  // 因为远端的 127.0.0.1 并不是本地 VS Code Extension Host。
  const localReceiverUrl = process.env.FRIDAY_RECEIVER_URL;
  // VS Code Remote 模式下，远端 127.0.0.1:17322 会通过 VS Code 的
  // `remote.autoForwardPorts` 设置自动转发到本地同名端口，本地 friday-receiver
  // 只需监听该端口即可接收音频，零点击。
  const DEFAULT_LOCAL_RECEIVER_URL = "http://127.0.0.1:17322/speak";
  const disableLocalReceiver = process.env.FRIDAY_DISABLE_LOCAL_RECEIVER === "1";

  function renderStatus(ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } }): void {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, "○ Friday off");
      return;
    }
    const speedLabel = speechRate === 1 ? "" : ` ${speechRate}×`;
    ctx.ui.setStatus(STATUS_KEY, speaking ? `◉ Friday speaking${speedLabel}` : `● Friday ${voiceMode}${speedLabel}`);
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
    const tts = spawn("uvx", [
      "edge-tts",
      "--text", text,
      "--write-media", output,
      "--voice", VOICES[voiceMode],
      "--rate", rateToEdgeTts(speechRate),
    ], {
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
    // RPC 客户端可消费该 widget 协议，并用单调 id 过滤状态同步造成的重复播放。
    ctx.ui.setWidget(BROWSER_SPEECH_WIDGET, [JSON.stringify({
      id: ++browserCommandId,
      ...command,
    })]);
  }

  function emitRemoteSpeech(command: Omit<BrowserSpeechCommand, "id">): void {
    const payload = `data: ${JSON.stringify({ id: ++browserCommandId, ...command })}\n\n`;
    // 多个浏览器标签可能同时保持 SSE 连接；仅向最新连接播放，避免重复发声。
    activeRemoteClient?.write(payload);
  }

  async function emitRemoteAudioSpeech(text: string): Promise<void> {
    const output = join(tmpdir(), `friday-browser-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
    try {
      const result = await pi.exec("uvx", [
        "edge-tts",
        "--text", text,
        "--write-media", output,
        "--voice", VOICES[voiceMode],
        "--rate", rateToEdgeTts(speechRate),
      ], { timeout: 60000 });
      if (result.code !== 0) {
        // edge-tts 失败时仍保留浏览器页面作为降级方案。
        emitRemoteSpeech({
          action: "speak",
          text,
          lang: voiceMode === "zh" ? "zh-CN" : "en-US",
          rate: speechRate,
        });
        return;
      }
      const audio = await readFile(output);
      const base64 = audio.toString("base64");
      const payload = JSON.stringify({ type: "mp3", data: base64, rate: speechRate });

      // 优先 POST 到本地 receiver。VS Code Remote 模式下，远端 127.0.0.1:17322
      // 通过 `remote.autoForwardPorts` 自动转发到本地同名端口；本地 friday-receiver
      // 监听后即可播放，零点击。可通过 FRIDAY_RECEIVER_URL 自定义 URL，或
      // FRIDAY_DISABLE_LOCAL_RECEIVER=1 强制走浏览器 SSE。
      if (!disableLocalReceiver) {
        const receiverUrl = localReceiverUrl ?? DEFAULT_LOCAL_RECEIVER_URL;
        // 用 fetch 直传 JSON，避免把 base64 MP3 塞进 sh/curl 参数触发 execve E2BIG
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(receiverUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            signal: controller.signal,
          });
          if (res.ok) return;
        } catch {
          // 连接拒绝或隧道未就绪时走浏览器 SSE 降级
        } finally {
          clearTimeout(timer);
        }
      }

      // 降级：浏览器 SSE（需用户手动转发端口 + 点"启用语音"）
      // MP3 已在生成时应用语速，浏览器无需再设 playbackRate。
      emitRemoteSpeech({ action: "speak", audio: `data:audio/mpeg;base64,${base64}`, rate: speechRate });
    } finally {
      await rm(output, { force: true }).catch(() => {});
    }
  }

  async function startRemoteSpeechServer(): Promise<string> {
    if (remoteServer) return `http://${REMOTE_SPEECH_HOST}:${REMOTE_SPEECH_PORT}`;

    const server = createServer((request, response) => {
      if (request.url === "/events") {
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        response.write(": connected\n\n");
        remoteClients.add(response);
        activeRemoteClient = response;
        request.on("close", () => {
          remoteClients.delete(response);
          if (activeRemoteClient === response) {
            activeRemoteClient = [...remoteClients].at(-1);
          }
        });
        return;
      }

      if (request.url === "/" || request.url === "/index.html") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(REMOTE_SPEECH_PAGE);
        return;
      }

      response.writeHead(404);
      response.end("Not found");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(REMOTE_SPEECH_PORT, REMOTE_SPEECH_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    remoteServer = server;
    return `http://${REMOTE_SPEECH_HOST}:${REMOTE_SPEECH_PORT}`;
  }

  function stopRemoteSpeechServer(): void {
    for (const client of remoteClients) client.end();
    remoteClients.clear();
    activeRemoteClient = undefined;
    remoteServer?.close();
    remoteServer = undefined;
  }

  pi.on("agent_start", () => {
    lastAssistantText = "";
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistantText = extractAssistantText(event.message);
  });

  // agent_settled 表示这一轮没有待执行工具、重试或 follow-up；只播报最终回答。
  pi.on("agent_settled", async (_event, ctx) => {
    if (!enabled || !lastAssistantText) return;
    const summary = summarizeForSpeech(lastAssistantText);
    if (!summary) return;

    const command = {
      action: "speak" as const,
      text: summary,
      lang: voiceMode === "zh" ? "zh-CN" : "en-US",
      rate: speechRate,
    };
    // VS Code Remote 即使通过 RPC 驱动，语音也必须发送到本地浏览器页面；
    // 通用 RPC widget 只有实现了 Friday 协议的客户端才能消费。
    if (isVSCodeRemote) {
      await emitRemoteAudioSpeech(summary);
      return;
    }
    if (ctx.mode === "rpc") {
      emitBrowserSpeech(ctx, command);
      return;
    }
    enqueueLocalSpeech(summary, ctx);
  });

  pi.registerCommand("friday", {
    description: "Friday 语音助手：/friday on|off|zh|en|speed <n>|test",
    getArgumentCompletions(prefix) {
      const value = prefix.trim().toLowerCase();
      return ["on", "off", "zh", "en", "speed", "test"]
        .filter((item) => item.startsWith(value))
        .map((item) => ({ value: item, label: item }));
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "on") {
        if (isVSCodeRemote) {
          try {
            if (!await hasEdgeTts()) {
              ctx.ui.notify("Friday 无法开启：未找到 uvx edge-tts。", "error");
              return;
            }
            const url = await startRemoteSpeechServer();
            enabled = true;
            renderStatus(ctx);
            ctx.ui.notify(
              [
                `Friday 已开启（VS Code Remote）。`,
                ``,
                `推荐（零点击）：本地运行 friday-receiver 监听 17322，`,
                `并在 settings.json 配置 "remote.autoForwardPorts": [17322]。`,
                `打开后所有语音都自动推到本地播放。`,
                ``,
                `降级路径：浏览器打开 ${url}，点"启用语音"。`,
              ].join("\n"),
              "info",
            );
          } catch (error) {
            ctx.ui.notify(`Friday 无法启动语音页面：${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }

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
        ctx.ui.notify(ctx.mode === "rpc" ? "Friday 已开启：RPC 客户端将使用浏览器语音播放。" : `Friday 已开启：本地播放器为 ${player}。`, "info");
        return;
      }

      if (command === "off") {
        enabled = false;
        stopLocalSpeech();
        if (ctx.mode === "rpc") emitBrowserSpeech(ctx, { action: "stop" });
        if (isVSCodeRemote) emitRemoteSpeech({ action: "stop" });
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

      if (command.startsWith("speed")) {
        const arg = args.trim().slice("speed".length).trim();
        if (!arg) {
          ctx.ui.notify(`Friday 当前语速：${speechRate}×（edge-tts ${rateToEdgeTts(speechRate)}）。`, "info");
          return;
        }
        // 接受 "1.25"、"=1.25"、"1.25x" 几种写法。
        const match = arg.match(/^=?\s*(\d+(?:\.\d+)?)\s*x?$/i);
        if (!match) {
          ctx.ui.notify("Friday 语速格式无效。示例：/friday speed 1.25（0.5–2.0）。", "error");
          return;
        }
        const next = Number.parseFloat(match[1]);
        if (!Number.isFinite(next) || next < 0.5 || next > 2.0) {
          ctx.ui.notify(`Friday 语速超出范围：${next}。允许 0.5–2.0。`, "error");
          return;
        }
        speechRate = next;
        renderStatus(ctx);
        ctx.ui.notify(`Friday 语速已设置为 ${speechRate}×（edge-tts ${rateToEdgeTts(speechRate)}）。`, "info");
        return;
      }

      if (command === "test") {
        if (!enabled) {
          ctx.ui.notify("Friday 尚未开启，请先执行 /friday on。", "warning");
          return;
        }
        const testCommand = {
          action: "speak" as const,
          text: voiceMode === "zh" ? "你好，我是 Friday，语音连接正常。" : "Hello, this is Friday. Speech is working.",
          lang: voiceMode === "zh" ? "zh-CN" : "en-US",
          rate: speechRate,
        };
        if (isVSCodeRemote) {
          // emitRemoteAudioSpeech 内部优先走本地 receiver（无需浏览器），
          // 失败再降级到 SSE。
          await emitRemoteAudioSpeech(testCommand.text);
        } else if (ctx.mode === "rpc") {
          emitBrowserSpeech(ctx, testCommand);
        } else {
          enqueueLocalSpeech(testCommand.text, ctx);
        }
        ctx.ui.notify("Friday 已发送测试语音。", "info");
        return;
      }

      ctx.ui.notify(
        `Friday 语音助手\n  状态：${enabled ? "开启" : "关闭"}\n  音色：${VOICES[voiceMode]}\n  语速：${speechRate}×（${rateToEdgeTts(speechRate)}）\n  模式：${isVSCodeRemote ? "VS Code 本地播放器" : ctx.mode === "rpc" ? "浏览器语音" : "本地 edge-tts"}${isVSCodeRemote ? `\n  播放器连接：${remoteClients.size}` : ""}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    renderStatus(ctx);
    if (!enabled) return;
    // 默认开启：补齐 /friday on 在 VS Code Remote 下启动 SSE server 的副作用，
    // 避免每次新会话都要手动 /friday on。
    if (isVSCodeRemote && !remoteServer) {
      if (!await hasEdgeTts()) {
        ctx.ui.notify("Friday 默认开启失败：未找到 uvx edge-tts。", "error");
        enabled = false;
        renderStatus(ctx);
        return;
      }
      try {
        const url = await startRemoteSpeechServer();
        ctx.ui.notify(
          [
            `Friday 已默认开启（VS Code Remote）。`,
            ``,
            `推荐（零点击）：本地运行 friday-receiver 监听 17322，`,
            `并在 settings.json 配置 "remote.autoForwardPorts": [17322]。`,
            `打开后所有语音都自动推到本地播放。`,
            ``,
            `降级路径：浏览器打开 ${url}，点"启用语音"。`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Friday 启动语音页面失败：${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        enabled = false;
        renderStatus(ctx);
      }
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopLocalSpeech();
    if (ctx.mode === "rpc") emitBrowserSpeech(ctx, { action: "stop" });
    if (isVSCodeRemote) emitRemoteSpeech({ action: "stop" });
    stopRemoteSpeechServer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
