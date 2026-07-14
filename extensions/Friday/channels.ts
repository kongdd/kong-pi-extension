import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BROWSER_SPEECH_WIDGET,
  DEFAULT_LOCAL_RECEIVER_URL,
  REMOTE_SPEECH_HOST,
  REMOTE_SPEECH_PORT,
  langFor,
  stopProc,
  type Player,
  type SpeakCommand,
  type StatusCtx,
  type VoiceMode,
} from "./lib";
import { findPlayer, mp3Base64, playMp3File, synthMp3 } from "./tts";

const SSE_PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "remote-speech-page.html"), "utf8");

// —— 本地 mpv 队列 ——
export function createLocalChannel(deps: {
  pi: ExtensionAPI;
  isEnabled: () => boolean;
  voice: () => VoiceMode;
  rate: () => number;
  onSpeaking: (v: boolean) => void;
  renderStatus: (ctx: StatusCtx) => void;
}) {
  let player: Player | undefined;
  let current: import("node:child_process").ChildProcess | undefined;
  let queue: string[] = [];
  let draining = false;
  let cancelGen = 0;

  const stop = () => {
    cancelGen++;
    queue = [];
    stopProc(current);
    current = undefined;
    deps.onSpeaking(false);
  };

  const enqueue = (text: string, ctx: StatusCtx) => {
    queue.push(text);
    if (draining) return;
    draining = true;
    void (async () => {
      while (deps.isEnabled() && queue.length) {
        const next = queue.shift();
        const g = cancelGen;
        if (!next || !player) continue;
        deps.onSpeaking(true);
        deps.renderStatus(ctx);
        const path = await synthMp3(deps.pi, next, deps.voice(), deps.rate(), "local");
        if (path && deps.isEnabled() && g === cancelGen) await playMp3File(player, path, (p) => { current = p; });
        current = undefined;
      }
      deps.onSpeaking(false);
      draining = false;
      deps.renderStatus(ctx);
    })();
  };

  const preparePlayer = async () => { player = await findPlayer(deps.pi); return player; };

  return { stop, enqueue, preparePlayer, get player() { return player; } };
}

// —— Remote：SSE + POST receiver ——
export function createRemoteChannel(deps: {
  pi: ExtensionAPI;
  voice: () => VoiceMode;
  rate: () => number;
  receiverUrl?: string;
  disableReceiver: boolean;
}) {
  let server: Server | undefined;
  const clients = new Set<ServerResponse>();
  let active: ServerResponse | undefined;
  let cmdId = 0;

  const sseEmit = (command: SpeakCommand) => {
    active?.write(`data: ${JSON.stringify({ id: ++cmdId, ...command })}\n\n`);
  };

  const start = async (): Promise<string> => {
    const base = `http://${REMOTE_SPEECH_HOST}:${REMOTE_SPEECH_PORT}`;
    if (server) return base;
    server = createServer((req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/event-stream", Connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        active = res;
        req.on("close", () => {
          clients.delete(res);
          if (active === res) active = [...clients].at(-1);
        });
        return;
      }
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
        res.end(SSE_PAGE);
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(REMOTE_SPEECH_PORT, REMOTE_SPEECH_HOST, () => { server!.off("error", reject); resolve(); });
    });
    return base;
  };

  const stop = () => {
    for (const c of clients) c.end();
    clients.clear();
    active = undefined;
    server?.close();
    server = undefined;
  };

  const postReceiver = async (url: string, body: string) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      return (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ac.signal })).ok;
    } catch { return false; } finally { clearTimeout(t); }
  };

  const speak = async (text: string) => {
    const path = await synthMp3(deps.pi, text, deps.voice(), deps.rate(), "remote");
    if (!path) {
      sseEmit({ action: "speak", text, lang: langFor(deps.voice()), rate: deps.rate() });
      return;
    }
    try {
      const base64 = await mp3Base64(path);
      const payload = JSON.stringify({ type: "mp3", data: base64, rate: deps.rate() });
      if (!deps.disableReceiver) {
        const url = deps.receiverUrl ?? DEFAULT_LOCAL_RECEIVER_URL;
        if (await postReceiver(url, payload)) return;
      }
      sseEmit({ action: "speak", audio: `data:audio/mpeg;base64,${base64}`, rate: deps.rate() });
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  };

  return {
    start, stop, speak,
    sseEmit,
    get clientCount() { return clients.size; },
    get running() { return !!server; },
  };
}

// —— RPC widget ——
export function createRpcChannel() {
  let id = 0;
  return {
    emit(ctx: StatusCtx, command: SpeakCommand) {
      ctx.ui.setWidget?.(BROWSER_SPEECH_WIDGET, [JSON.stringify({ id: ++id, ...command })]);
    },
  };
}