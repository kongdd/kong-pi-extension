import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAYERS, VOICES, playerArgs, rateToEdgeTts, spawnQuiet, waitForExit } from "./lib";
import type { Player, PlayerName, VoiceMode } from "./lib";

const EDGE_TTS = "edge-tts-rust";

function edgeArgs(text: string, output: string, voice: VoiceMode, rate: number): string[] {
  return [
    `--text=${text}`, "--write-media", output, "--voice", VOICES[voice],
    `--rate=${rateToEdgeTts(rate)}`, "--output-format", "audio-24khz-48kbitrate-mono-mp3",
  ];
}

export async function hasEdgeTts(pi: ExtensionAPI): Promise<boolean> {
  return (await pi.exec(EDGE_TTS, ["--version"], { timeout: 5000 })).code === 0;
}

export async function findPlayer(platform = process.platform, path = process.env.PATH ?? ""): Promise<Player | undefined> {
  const windows = platform === "win32";
  const dirs = path.split(windows ? ";" : ":")
    .map((dir) => windows ? dir.replace(/^"(.*)"$/, "$1") : dir)
    .filter(Boolean);
  const players: PlayerName[] = ["audio-play"];
  if (platform === "darwin") players.push("afplay");
  players.push(...PLAYERS);

  for (const name of players) {
    for (const dir of dirs) {
      const command = resolve(dir, windows ? `${name}.exe` : name);
      try {
        if (!(await stat(command)).isFile()) continue;
        if (!windows) await access(command, constants.X_OK);
        return { name, command };
      } catch {
        // 跳过不存在或不可执行的候选文件。
      }
    }
  }
}

export async function synthMp3(pi: ExtensionAPI, text: string, voice: VoiceMode, rate: number, tag: string): Promise<string | undefined> {
  const output = join(tmpdir(), `friday-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  if ((await pi.exec(EDGE_TTS, edgeArgs(text, output, voice, rate), { timeout: 60000 })).code !== 0) {
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
  const proc = spawnQuiet(player.command, playerArgs(player.name, path));
  onSpawn?.(proc);
  await waitForExit(proc);
  await rm(path, { force: true }).catch(() => {});
}

export async function mp3Base64(path: string): Promise<string> {
  return (await readFile(path)).toString("base64");
}