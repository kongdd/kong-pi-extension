import { spawn, type ChildProcess } from "node:child_process";

export type VoiceMode = "zh" | "en";
export type Player = "mpv" | "ffplay" | "mplayer";
export type SpeakCommand = {
  action: "speak" | "stop";
  text?: string;
  lang?: string;
  audio?: string;
  rate?: number;
};
export type StatusCtx = {
  hasUI: boolean;
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, level: "info" | "warning" | "error"): void;
    setWidget?(key: string, lines: string[] | undefined): void;
  };
};

export const STATUS_KEY = "friday";
export const BROWSER_SPEECH_WIDGET = "friday-speech";
export const VOICES: Record<VoiceMode, string> = {
  zh: "zh-CN-XiaoxiaoNeural",
  en: "en-US-AriaNeural",
};
export const PLAYERS = ["mpv", "ffplay", "mplayer"] as const;
export const REMOTE_SPEECH_HOST = "127.0.0.1";
export const REMOTE_SPEECH_PORT = 17321;
export const DEFAULT_LOCAL_RECEIVER_URL = "http://127.0.0.1:17322/speak";
export const FRIDAY_CMDS = ["on", "off", "zh", "en", "speed", "test"] as const;

export const langFor = (m: VoiceMode) => (m === "zh" ? "zh-CN" : "en-US");

export function rateToEdgeTts(rate: number): string {
  const p = Math.round((rate - 1) * 100);
  return `${p >= 0 ? "+" : ""}${p}%`;
}

export function isVSCodeRemoteEnv(): boolean {
  return Boolean(
    process.env.FRIDAY_REMOTE === "1"
    || (process.env.VSCODE_IPC_HOOK_CLI
      && (process.env.SSH_CONNECTION || process.env.WSL_DISTRO_NAME)),
  );
}

export function remoteOnHelp(sseUrl: string, isDefault = false): string {
  return [
    `Friday 已${isDefault ? "默认" : ""}开启（VS Code Remote）。`,
    "",
    "推荐：本地 friday-receiver 监听 17322，settings.json 配置 remote.autoForwardPorts: [17322]。",
    "降级：浏览器打开 " + sseUrl + "，点「启用语音」。",
  ].join("\n");
}

export function waitForExit(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    proc.once("error", () => resolve(null));
    proc.once("close", (code) => resolve(code));
  });
}

export function stopProc(proc: ChildProcess | undefined): void {
  if (proc && !proc.killed) proc.kill("SIGTERM");
}

export function playerArgs(program: Player, file: string): string[] {
  if (program === "ffplay") return ["-nodisp", "-autoexit", "-loglevel", "error", file];
  if (program === "mpv") return ["--no-video", "--really-quiet", file];
  return ["-really-quiet", file];
}

export const spawnQuiet = (cmd: string, args: string[]) => spawn(cmd, args, { stdio: "ignore" });