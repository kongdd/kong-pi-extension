import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalChannel, createRemoteChannel, createRpcChannel } from "./channels";
import { STATUS_KEY, langFor, remoteOnHelp, type StatusCtx, type VoiceMode } from "./lib";
import { hasEdgeTts } from "./tts";

export type SpeechEngine = ReturnType<typeof createSpeechEngine>;

export function createSpeechEngine(
  pi: ExtensionAPI,
  opts: { isVSCodeRemote: boolean; localReceiverUrl?: string; disableLocalReceiver: boolean },
) {
  let enabled = false;
  let voiceMode: VoiceMode = "zh";
  let speechRate = 1.0;
  let speaking = false;

  const remote = createRemoteChannel({
    pi,
    voice: () => voiceMode,
    rate: () => speechRate,
    receiverUrl: opts.localReceiverUrl,
    disableReceiver: opts.disableLocalReceiver,
  });
  const rpc = createRpcChannel();

  const renderStatus = (ctx: StatusCtx) => {
    if (!ctx.hasUI) return;
    if (!enabled) { ctx.ui.setStatus(STATUS_KEY, "○ Friday off"); return; }
    const speed = speechRate === 1 ? "" : ` ${speechRate}×`;
    ctx.ui.setStatus(STATUS_KEY, speaking ? `◉ Friday speaking${speed}` : `● Friday ${voiceMode}${speed}`);
  };

  const local = createLocalChannel({
    pi,
    isEnabled: () => enabled,
    voice: () => voiceMode,
    rate: () => speechRate,
    onSpeaking: (v) => { speaking = v; },
    renderStatus,
  });

  const makeSpeak = (text: string) => ({ action: "speak" as const, text, lang: langFor(voiceMode), rate: speechRate });

  const deliverSpeech = async (text: string, ctx: StatusCtx & { mode?: string }) => {
    if (opts.isVSCodeRemote) { await remote.speak(text); return; }
    if (ctx.mode === "rpc") { rpc.emit(ctx, makeSpeak(text)); return; }
    local.enqueue(text, ctx);
  };

  const emitStop = (ctx: StatusCtx & { mode?: string }) => {
    if (ctx.mode === "rpc") rpc.emit(ctx, { action: "stop" });
    if (opts.isVSCodeRemote) remote.sseEmit({ action: "stop" });
  };

  const ensureRemoteReady = async (ctx: StatusCtx) => {
    if (!await hasEdgeTts(pi)) {
      ctx.ui.notify("Friday 无法开启：未找到 uvx edge-tts。", "error");
      return undefined;
    }
    try { return await remote.start(); }
    catch (e) {
      ctx.ui.notify(`Friday 无法启动语音页面：${e instanceof Error ? e.message : String(e)}`, "error");
      return undefined;
    }
  };

  const turnOn = async (ctx: StatusCtx & { mode?: string }) => {
    if (opts.isVSCodeRemote) {
      const url = await ensureRemoteReady(ctx);
      if (!url) return;
      enabled = true;
      renderStatus(ctx);
      ctx.ui.notify(remoteOnHelp(url), "info");
      return;
    }
    if (ctx.mode !== "rpc") {
      const [ok, p] = await Promise.all([hasEdgeTts(pi), local.preparePlayer()]);
      if (!ok || !p) {
        ctx.ui.notify(`Friday 无法开启：${[!ok && "未找到 uvx edge-tts", !p && "未找到 mpv、ffplay 或 mplayer"].filter(Boolean).join("；")}`, "error");
        return;
      }
    }
    enabled = true;
    renderStatus(ctx);
    ctx.ui.notify(ctx.mode === "rpc" ? "Friday 已开启：RPC 浏览器语音。" : `Friday 已开启：本地播放器 ${local.player}。`, "info");
  };

  return {
    get enabled() { return enabled; },
    set enabled(v: boolean) { enabled = v; },
    get voiceMode() { return voiceMode; },
    set voiceMode(v: VoiceMode) { voiceMode = v; },
    get speechRate() { return speechRate; },
    set speechRate(v: number) { speechRate = v; },
    get remoteClientCount() { return remote.clientCount; },
    get hasRemoteServer() { return remote.running; },
    renderStatus,
    stopLocalSpeech: () => local.stop(),
    stopRemoteSpeechServer: () => remote.stop(),
    deliverSpeech,
    emitStop,
    ensureRemoteReady,
    turnOn,
  };
}