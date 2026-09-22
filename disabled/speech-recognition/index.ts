import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SERVICE = process.env.QWEN_ASR_SERVICE ?? "qwen-audio.service";
const AUDIO_URL = process.env.QWEN_AUDIO_URL ?? "http://127.0.0.1:8001";
const SUBTITLE_SCRIPT = fileURLToPath(new URL("subtitles.py", import.meta.url));

const Params = Type.Object({
  audio_path: Type.String({ description: "音频文件路径；相对路径基于当前工作目录" }),
  reference_path: Type.Optional(Type.String({ description: "人工参考文本路径；提供后计算 CER" })),
});

type Result = {
  audioPath: string;
  transcript: string;
  cer?: number;
  accuracy?: number;
};

const cleanArg = (value: string) => {
  let text = value.trim();
  if (/^(['"]).*\1$/.test(text)) text = text.slice(1, -1);
  return text.replace(/^@/, "");
};

const absolute = (cwd: string, value: string) => {
  const path = cleanArg(value);
  return isAbsolute(path) ? path : resolve(cwd, path);
};

const normalize = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).join("");

function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next.push(Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1])));
    }
    row = next;
  }
  return row[b.length];
}

async function ready(signal?: AbortSignal) {
  try {
    return (await fetch(`${AUDIO_URL}/health`, { signal })).ok;
  } catch {
    return false;
  }
}

async function ensureService(pi: ExtensionAPI, signal?: AbortSignal) {
  if (await ready(signal)) return;

  const start = await pi.exec("systemctl", ["--user", "start", SERVICE], {
    signal,
    timeout: 10_000,
  });
  if (start.code !== 0) throw new Error(start.stderr.trim() || `无法启动 ${SERVICE}`);

  for (let i = 0; i < 120; i++) {
    await sleep(1_000, undefined, { signal });
    if (await ready(signal)) return;
  }
  throw new Error(`语音识别服务未就绪：${AUDIO_URL}`);
}

async function recognize(
  pi: ExtensionAPI,
  cwd: string,
  audio: string,
  reference?: string,
  signal?: AbortSignal,
): Promise<Result> {
  await ensureService(pi, signal);
  const audioPath = absolute(cwd, audio);
  const response = await fetch(`${AUDIO_URL}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio_path: audioPath }),
    signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body || `语音识别失败：HTTP ${response.status}`);

  const transcript = (JSON.parse(body) as { transcript: string }).transcript.trim();
  const result: Result = { audioPath, transcript };
  if (reference) {
    const expected = normalize(await readFile(absolute(cwd, reference), "utf8"));
    if (!expected) throw new Error("参考文本为空");
    result.cer = distance(expected, normalize(transcript)) / expected.length;
    result.accuracy = Math.max(0, 1 - result.cer);
  }
  return result;
}

const format = (result: Result) => {
  let text = `识别结果：${result.transcript}`;
  if (result.cer !== undefined) {
    text += `\nCER：${(result.cer * 100).toFixed(2)}%`;
    text += `\n字符正确率：${((result.accuracy ?? 0) * 100).toFixed(2)}%`;
  }
  return text;
};

export default function speechRecognition(pi: ExtensionAPI) {
  pi.registerTool({
    name: "speech_recognize",
    label: "Speech Recognize",
    description: "使用本机 Qwen-Audio 服务转写本地音频；可提供人工参考文本并计算 CER。",
    promptSnippet: "Transcribe a local audio file with Qwen-Audio",
    promptGuidelines: ["Use speech_recognize when the user asks to transcribe or evaluate a local audio file."],
    parameters: Params,
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "正在识别音频…" }] });
      const result = await recognize(pi, ctx.cwd, params.audio_path, params.reference_path, signal);
      return {
        content: [{ type: "text", text: format(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("asr", {
    description: "转写音频并填入输入框：/asr <audio_path>",
    handler: async (args, ctx) => {
      let audio = args.trim();
      if (!audio && ctx.hasUI) audio = (await ctx.ui.input("音频路径：", "/path/audio.wav")) ?? "";
      if (!audio) {
        ctx.ui.notify("用法：/asr <audio_path>", "warning");
        return;
      }

      ctx.ui.setStatus("asr", "语音识别中…");
      try {
        const result = await recognize(pi, ctx.cwd, audio);
        const current = ctx.ui.getEditorText();
        ctx.ui.setEditorText(current ? `${current} ${result.transcript}` : result.transcript);
        ctx.ui.notify(format(result), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("asr", undefined);
      }
    },
  });

  pi.registerCommand("asr-srt", {
    description: "转写音频并生成字幕：/asr-srt <audio_path> [output.srt]",
    handler: async (args, ctx) => {
      const [audioArg, outputArg] = args.trim().split(/\s+/);
      if (!audioArg) {
        ctx.ui.notify("用法：/asr-srt <audio_path> [output.srt]", "warning");
        return;
      }

      const audioPath = absolute(ctx.cwd, audioArg);
      const outputPath = outputArg
        ? absolute(ctx.cwd, outputArg)
        : audioPath.replace(/\.[^.\\/]+$/, ".srt");
      ctx.ui.setStatus("asr", "字幕识别中…");
      try {
        await ensureService(pi);
        const result = await pi.exec(
          "python",
          [SUBTITLE_SCRIPT, audioPath, outputPath],
          { timeout: 3_600_000 },
        );
        if (result.code !== 0) throw new Error(result.stderr.trim() || "字幕生成失败");
        ctx.ui.notify(`字幕已生成：${outputPath}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("asr", undefined);
      }
    },
  });
}
