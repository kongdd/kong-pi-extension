/**
 * Friday — pi 语音助手（/friday on|off|zh|en|speed|test|config）
 * 本地：edge-tts + mpv；Remote：POST 17322 或 SSE 17321 降级。
 */

import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFridayConfig, savedAudioPath, saveFridayConfig } from "./config";
import { FRIDAY_CMDS, STATUS_KEY, VOICES, isRemoteEnv, rateToEdgeTts, remoteOnHelp } from "./lib";
import { createSpeechEngine } from "./speech-engine";
import { extractAssistantText, summarizeForSpeech } from "./text";

export default function friday(pi: ExtensionAPI): void {
  const isRemote = isRemoteEnv();
  const enableRemoteSse = process.env.FRIDAY_ENABLE_SSE === "1";
  const config = loadFridayConfig();
  const engine = createSpeechEngine(pi, {
    isRemote,
    enableRemoteSse,
    saveAudio: config.saveAudio,
    localReceiverUrl: process.env.FRIDAY_RECEIVER_URL,
    disableLocalReceiver: process.env.FRIDAY_DISABLE_LOCAL_RECEIVER === "1",
  });

  let lastAssistantText = "";

  pi.on("agent_start", () => { lastAssistantText = ""; });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistantText = extractAssistantText(event.message);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!engine.enabled || !lastAssistantText) return;
    const summary = summarizeForSpeech(lastAssistantText);
    if (!summary) return;
    await engine.deliverSpeech(summary, ctx);
  });

  pi.registerCommand("friday", {
    description: "Friday 语音：on|off|zh|en|speed <n>|test|config --save-audio=yes/no",
    getArgumentCompletions(prefix) {
      const v = prefix.trim().toLowerCase();
      return FRIDAY_CMDS.filter((c) => c.startsWith(v)).map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      const saveAudioArg = cmd.match(/^config\s+--save-audio=(yes|no)$/);

      if (cmd === "config" || saveAudioArg) {
        if (saveAudioArg) {
          const previous = engine.saveAudio;
          engine.saveAudio = saveAudioArg[1] === "yes";
          try {
            await saveFridayConfig({ saveAudio: engine.saveAudio });
          } catch (error) {
            engine.saveAudio = previous;
            ctx.ui.notify(`Friday 配置保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
            return;
          }
        }
        const folder = dirname(savedAudioPath(ctx.cwd, ctx.sessionManager.getSessionId()));
        ctx.ui.notify(`Friday save-audio=${engine.saveAudio ? "yes" : "no"}\n${folder}`, "info");
        return;
      }
      if (cmd.startsWith("config")) {
        ctx.ui.notify("格式：/friday config --save-audio=yes/no", "error");
        return;
      }
      if (cmd === "on") {
        await engine.turnOn(ctx);
        return;
      }
      if (cmd === "off") {
        engine.enabled = false;
        engine.stopLocalSpeech();
        engine.emitStop(ctx);
        engine.renderStatus(ctx);
        ctx.ui.notify("Friday 已关闭。", "info");
        return;
      }
      if (cmd === "zh" || cmd === "en") {
        engine.voiceMode = cmd;
        engine.renderStatus(ctx);
        ctx.ui.notify(`Friday 已切换为${cmd === "zh" ? "中文" : "英文"}音色。`, "info");
        return;
      }
      if (cmd.startsWith("speed")) {
        const arg = args.trim().slice(5).trim();
        if (!arg) {
          ctx.ui.notify(`Friday 语速：${engine.speechRate}×（${rateToEdgeTts(engine.speechRate)}）`, "info");
          return;
        }
        const m = arg.match(/^=?\s*(\d+(?:\.\d+)?)\s*x?$/i);
        if (!m) {
          ctx.ui.notify("语速格式无效，示例：/friday speed 1.25（0.5–2.0）", "error");
          return;
        }
        const next = Number.parseFloat(m[1]);
        if (!Number.isFinite(next) || next < 0.5 || next > 2.0) {
          ctx.ui.notify(`语速超出范围：${next}`, "error");
          return;
        }
        engine.speechRate = next;
        engine.renderStatus(ctx);
        ctx.ui.notify(`Friday 语速 ${engine.speechRate}×（${rateToEdgeTts(engine.speechRate)}）`, "info");
        return;
      }
      if (cmd === "test") {
        if (!engine.enabled) {
          await engine.turnOn(ctx);
          if (!engine.enabled) return;
        }
        const text = engine.voiceMode === "zh"
          ? "你好，我是 Friday，语音连接正常。"
          : "Hello, this is Friday. Speech is working.";
        const delivered = await engine.deliverSpeech(text, ctx);
        ctx.ui.notify(
          delivered ? "Friday 已发送测试语音。" : "Friday 测试失败：未连接播放器。",
          delivered ? "info" : "error",
        );
        return;
      }

      const mode = isRemote ? "SSH/远程"
        : ctx.mode === "rpc" ? "RPC 浏览器" : "本地 edge-tts";
      ctx.ui.notify(
        `Friday\n  状态：${engine.enabled ? "开" : "关"}\n  音色：${VOICES[engine.voiceMode]}\n  语速：${engine.speechRate}×\n  保存音频：${engine.saveAudio ? "是" : "否"}\n  模式：${mode}${enableRemoteSse ? `\n  SSE 连接：${engine.remoteClientCount}` : ""}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    engine.renderStatus(ctx);
    if (!enableRemoteSse || !engine.enabled || !isRemote || engine.hasRemoteServer) return;
    const url = await engine.ensureRemoteReady(ctx);
    if (!url) {
      engine.enabled = false;
      engine.renderStatus(ctx);
      return;
    }
    ctx.ui.notify(remoteOnHelp(url, true), "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    engine.stopLocalSpeech();
    engine.emitStop(ctx);
    engine.stopRemoteSpeechServer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}