import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playerArgs } from "../lib";
import { findPlayer } from "../tts";

test.each([
  ["win32", ["ffplay.exe", "audio-play.exe"], "audio-play.exe", "audio-play"],
  ["win32", ["ffplay.exe"], "ffplay.exe", "ffplay"],
  ["darwin", ["audio-play", "afplay"], "audio-play", "audio-play"],
  ["darwin", ["afplay", "ffplay"], "afplay", "afplay"],
  ["linux", ["audio-play", "ffplay"], "audio-play", "audio-play"],
] as const)("finds the preferred player on %s with %j on PATH", async (platform, files, exe, name) => {
  const root = await mkdtemp(join(tmpdir(), "friday-player-"));
  try {
    const bin = join(root, "音频 工具");
    await mkdir(bin);
    for (const file of files) await writeFile(join(bin, file), "", { mode: 0o755 });

    const path = platform === "win32" ? `${root};"${bin}"` : `${root}:${bin}`;
    expect(await findPlayer(platform, path)).toEqual({ name, command: join(bin, exe) });
    expect(await findPlayer(platform, root)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lightweight players take the MP3 path as a single argument", () => {
  const file = "示例 音频.mp3";
  expect(playerArgs("audio-play", file)).toEqual([file]);
  expect(playerArgs("afplay", file)).toEqual([file]);
});
