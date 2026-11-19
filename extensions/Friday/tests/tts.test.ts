import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VOICES } from "../lib";
import { synthMp3 } from "../tts";

test("使用 Rust CLI 合成 MP3，并传递负语速", async () => {
  const pi = {
    exec: async (command: string, args: string[]) => {
      expect(command).toBe("edge-tts-rust");
      const output = args[2]!;
      expect(output).toEndWith(".mp3");
      expect(args).toEqual([
        "--text=你好", "--write-media", output, "--voice", VOICES.zh,
        "--rate=-10%", "--output-format", "audio-24khz-48kbitrate-mono-mp3",
      ]);
      await writeFile(output, "test audio");
      return { code: 0 };
    },
  } as unknown as ExtensionAPI;

  const output = await synthMp3(pi, "你好", "zh", 0.9, "test");
  expect(output).toBeDefined();
  if (output) await rm(output);
});
