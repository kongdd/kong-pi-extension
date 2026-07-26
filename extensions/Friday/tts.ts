import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAYERS, VOICES, playerArgs, rateToEdgeTts, spawnQuiet, waitForExit } from "./lib";
import type { Player, VoiceMode } from "./lib";

function edgeArgs(text: string, output: string, voice: VoiceMode, rate: number): string[] {
  return ["edge-tts", "--text", text, "--write-media", output, "--voice", VOICES[voice], "--rate", rateToEdgeTts(rate)];
}

export async function hasEdgeTts(pi: ExtensionAPI): Promise<boolean> {
  return (await pi.exec("uvx", ["edge-tts", "--version"], { timeout: 5000 })).code === 0;
}

export async function findPlayer(pi: ExtensionAPI): Promise<Player | undefined> {
  for (const c of PLAYERS) {
    if ((await pi.exec("sh", ["-lc", `command -v ${c}`], { timeout: 2000 })).code === 0) return c;
  }
}

export async function synthMp3(pi: ExtensionAPI, text: string, voice: VoiceMode, rate: number, tag: string): Promise<string | undefined> {
  const output = join(tmpdir(), `friday-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  if ((await pi.exec("uvx", edgeArgs(text, output, voice, rate), { timeout: 60000 })).code !== 0) {
    await rm(output, { force: true }).catch(() => {});
    return undefined;
  }
  return output;
}

export async function archiveMp3(path: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(path, destination);
}

export async function synthSavedMp3(
  pi: ExtensionAPI,
  text: string,
  voice: VoiceMode,
  rate: number,
  destination: string,
): Promise<boolean> {
  const path = await synthMp3(pi, text, voice, rate, "saved");
  if (!path) return false;
  try {
    await archiveMp3(path, destination);
    return true;
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

export async function playMp3File(player: Player, path: string, onSpawn?: (p: import("node:child_process").ChildProcess) => void): Promise<void> {
  const proc = spawnQuiet(player, playerArgs(player, path));
  onSpawn?.(proc);
  await waitForExit(proc);
  await rm(path, { force: true }).catch(() => {});
}

export async function mp3Base64(path: string): Promise<string> {
  return (await readFile(path)).toString("base64");
}