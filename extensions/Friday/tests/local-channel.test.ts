import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalChannel, type LocalSpeechPhase } from "../channels";
import type { StatusCtx } from "../lib";

test.skipIf(process.platform === "win32")("stopping a drain prevents stale UI access and discards its queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friday-channel-"));
  const release = Promise.withResolvers<void>();
  const synthesized: string[] = [];
  const phases: LocalSpeechPhase[] = [];
  let oldMp3 = "";
  let oldCtxReads = 0;
  let stale = false;
  const ui = { setStatus() {}, notify() {} };
  const oldCtx: StatusCtx = {
    get hasUI() {
      oldCtxReads++;
      if (stale) throw new Error("stale context");
      return true;
    },
    ui,
  };
  const pi = {
    async exec(_command: string, [text, , output]: string[]) {
      synthesized.push(text);
      if (text === "--text=old") {
        oldMp3 = output;
        await release.promise;
      }
      await writeFile(output, text);
      return { code: 0 };
    },
  } as unknown as ExtensionAPI;
  const channel = createLocalChannel({
    pi,
    isEnabled: () => true,
    voice: () => "zh",
    rate: () => 1,
    onPhase(phase, ctx) {
      phases.push(phase);
      if (ctx?.hasUI) ctx.ui.setStatus("friday", phase);
    },
  });

  let stopped: Promise<void> | undefined;
  try {
    await writeFile(join(dir, "audio-play"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const path = process.env.PATH;
    let player: ReturnType<typeof channel.preparePlayer>;
    try {
      process.env.PATH = dir;
      player = channel.preparePlayer();
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    expect((await player)?.command).toBe(join(dir, "audio-play"));

    const oldArchive = join(dir, "old.mp3");
    stopped = channel.enqueue("old", oldCtx, oldArchive);
    channel.enqueue("discard", oldCtx);
    channel.stop(); // also called by session_shutdown before the context becomes stale
    stale = true;

    const nextArchive = join(dir, "next.mp3");
    const next = channel.enqueue("next", { hasUI: true, ui }, nextArchive);
    expect(synthesized).toEqual(["--text=old", "--text=next"]);
    expect(phases).toEqual(["synthesizing", "idle", "synthesizing"]);
    release.resolve();
    await Promise.all([stopped, next]);

    expect(phases).toEqual(["synthesizing", "idle", "synthesizing", "speaking", "idle"]);
    expect(oldCtxReads).toBe(1);
    expect(await Bun.file(oldMp3).exists()).toBe(false);
    expect(await Bun.file(oldArchive).exists()).toBe(false);
    expect(await readFile(nextArchive, "utf8")).toBe("--text=next");
  } finally {
    release.resolve();
    await stopped;
    channel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
