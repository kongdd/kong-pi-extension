import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalChannel, createRemoteChannel, createRpcChannel } from "./channels";
import { projectName, savedAudioPath } from "./config";
import { STATUS_KEY, langFor, remoteOnHelp, type StatusCtx, type VoiceMode } from "./lib";
import { hasEdgeTts, synthSavedMp3 } from "./tts";

export type SpeechEngine = ReturnType<typeof createSpeechEngine>;

export function createSpeechEngine(
  pi: ExtensionAPI,
  opts: {
    isRemote: boolean;
    enableRemoteSse: boolean;
    saveAudio: boolean;
    localReceiverUrl?: string;
    disableLocalReceiver: boolean;
  },
) {
  let enabled = opts.isRemote;
  let voiceMode: VoiceMode = "zh";
  let speechRate = 1.0;
  let saveAudio = opts.saveAudio;
  let speaking = false;
  let warnedDisconnected = false;

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

  const deliverSpeech = async (text: string, ctx: ExtensionContext): Promise<boolean> => {
    const project = projectName(ctx.cwd);
    const spokenText = voiceMode === "zh"
      ? `Project ${project}。${text}`
      : `Project ${project}. ${text}`;
    const saveTo = saveAudio
      ? savedAudioPath(ctx.cwd, ctx.sessionManager.getSessionId())
      : undefined;
    if (opts.isRemote) {
      const channel = await remote.speak(spokenText, ctx, saveTo);
      if (channel === "none") {
        if (!warnedDisconnected) {
          ctx.ui.notify("Friday 无可用播放器：17322 接收器不可达，且 17321 浏览器未连接。", "warning");
          warnedDisconnected = true;
        }
        return false;
      }
      warnedDisconnected = false;
      return true;
    }
    if (ctx.mode === "rpc") {
      if (saveTo) {
        try {
          if (!await synthSavedMp3(pi, spokenText, voiceMode, speechRate, saveTo)) {
            ctx.ui.notify("Friday 音频保存失败：edge-tts 合成失败。", "warning");
          }
        } catch (error) {
          ctx.ui.notify(`Friday 音频保存失败：${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
      rpc.emit(ctx, makeSpeak(spokenText));
      return true;
    }
    local.enqueue(spokenText, ctx, saveTo);
    return true;
  };

  const emitStop = (ctx: StatusCtx & { mode?: string }) => {
    if (ctx.mode === "rpc") rpc.emit(ctx, { action: "stop" });
    if (opts.isRemote) remote.sseEmit({ action: "stop" });
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
    warnedDisconnected = false;
    if (opts.isRemote) {
      if (opts.enableRemoteSse) {
        const url = await ensureRemoteReady(ctx);
        if (!url) return;
        enabled = true;
        renderStatus(ctx);
        ctx.ui.notify(remoteOnHelp(url), "info");
        return;
      }
      if (!await hasEdgeTts(pi)) {
        ctx.ui.notify("Friday 无法开启：未找到 uvx edge-tts。", "error");
        return;
      }
      enabled = true;
      renderStatus(ctx);
      ctx.ui.notify("Friday 已开启：远程 17322 接收器。", "info");
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
    get saveAudio() { return saveAudio; },
    set saveAudio(v: boolean) { saveAudio = v; },
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