import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type FridayConfig = { saveAudio: boolean };

const piConfigDir = () => process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi");
const agentDir = () => join(piConfigDir(), "agent");
const configPath = () => join(piConfigDir(), "Friday.json");

export function loadFridayConfig(): FridayConfig {
  try {
    const config = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<FridayConfig>;
    return { saveAudio: config.saveAudio === true };
  } catch {
    return { saveAudio: false };
  }
}

export async function saveFridayConfig(config: FridayConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

const safeName = (text: string) => text.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "unknown";
const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export const projectName = (cwd: string) => basename(resolve(cwd)) || "root";

export function savedAudioPath(cwd: string, sessionId: string, now = new Date()): string {
  const project = safeName(projectName(cwd));
  const session = safeName(sessionId);
  const stamp = [
    now.getFullYear(), "-", pad(now.getMonth() + 1), "-", pad(now.getDate()),
    "_", pad(now.getHours()), "-", pad(now.getMinutes()), "-", pad(now.getSeconds()),
    "-", pad(now.getMilliseconds(), 3),
  ].join("");
  return join(agentDir(), "media", "Friday", project, session, `${stamp}.mp3`);
}
