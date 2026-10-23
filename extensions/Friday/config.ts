import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type FridayConfig = { saveAudio: boolean; enabled?: boolean; mode?: "local" | "remote" };
export type FridayScope = "global" | "local";

const piConfigDir = () => process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi");
const agentDir = () => join(piConfigDir(), "agent");
const configPath = (scope: FridayScope = "global", cwd = process.cwd()) =>
  scope === "local" ? join(cwd, ".pi", "Friday.json") : join(piConfigDir(), "Friday.json");

function readConfig(path: string): Partial<FridayConfig> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function loadFridayConfig(cwd?: string): FridayConfig {
  const config = readConfig(configPath());
  const local = cwd ? readConfig(configPath("local", cwd)) : {};
  return {
    saveAudio: config.saveAudio === true,
    mode: config.mode === "local" || config.mode === "remote" ? config.mode : undefined,
    enabled: typeof local.enabled === "boolean" ? local.enabled
      : typeof config.enabled === "boolean" ? config.enabled : undefined,
  };
}

export async function saveFridayConfig(
  config: Partial<FridayConfig>,
  scope: FridayScope = "global",
  cwd = process.cwd(),
): Promise<void> {
  const path = configPath(scope, cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...readConfig(path), ...config }, null, 2)}\n`, "utf8");
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
