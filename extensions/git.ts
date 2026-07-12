/** Git helpers: /git-ai <description>, /git <command>. */
import { getModel } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODEL = getModel("minimax-cn", "MiniMax-M3");
const DIFF_LIMIT = 60_000;
type Pending = { files: string[]; message: string; snapshot: string };
const pending = new Map<string, Pending>();

async function git(pi: ExtensionAPI, cwd: string, args: string[], ok = [0]) {
  const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
  if (!ok.includes(result.code)) throw new Error(result.stderr.trim() || "git 执行失败");
  return result.stdout;
}

function paths(output: string) {
  return output.split("\0").filter(Boolean);
}

async function changedFiles(pi: ExtensionAPI, cwd: string) {
  const tracked = paths(await git(pi, cwd, ["diff", "HEAD", "--name-only", "-z"]));
  const untracked = paths(await git(pi, cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])];
}

async function untrackedFiles(pi: ExtensionAPI, cwd: string, files: string[]) {
  return new Set(paths(await git(
    pi,
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...files],
  )));
}

async function changes(pi: ExtensionAPI, cwd: string, files: string[]) {
  const patches = [await git(pi, cwd, ["diff", "HEAD", "--no-ext-diff", "--", ...files])];
  const untracked = await untrackedFiles(pi, cwd, files);

  for (const file of files.filter((path) => untracked.has(path))) {
    patches.push(await git(
      pi,
      cwd,
      ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", file],
      [0, 1],
    ));
  }
  return patches.join("\n");
}

async function stats(pi: ExtensionAPI, cwd: string, files: string[]) {
  const output = [await git(pi, cwd, ["diff", "HEAD", "--numstat", "--", ...files])];
  const untracked = await untrackedFiles(pi, cwd, files);
  const status = paths(await git(pi, cwd, ["status", "--porcelain=v1", "-z", "--", ...files]));
  const state = new Map(status.map((entry) => [entry.slice(3), entry.slice(0, 2)]));

  for (const file of files.filter((path) => untracked.has(path))) {
    output.push(await git(pi, cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", file], [0, 1]));
  }
  return output.join("").trim().split("\n").filter(Boolean)
    .map((line) => {
      const [added, deleted, ...file] = line.split("\t");
      const path = file.join("\t").split(" => ").at(-1) ?? file.join("\t");
      const code = state.get(path) ?? "??";
      const type = code === "??" || code.includes("A") ? "A" : code.includes("D") ? "D" : "M";
      const format = (value: string) => value.padStart(3, " ");
      return `  +${format(added)}  -${format(deleted)}  ${type}  ${path}`;
    })
    .join("\n");
}

function responseText(messages: readonly any[]) {
  const content = messages.filter((message) => message.role === "assistant").at(-1)?.content;
  return Array.isArray(content)
    ? content.map((part) => part?.text ?? "").join("")
    : String(content ?? "");
}

async function review(pi: ExtensionAPI, cwd: string, request: string) {
  const available = await changedFiles(pi, cwd);
  if (!available.length) throw new Error("当前没有未提交修改");

  const diff = await changes(pi, cwd, available);
  if (!MODEL) throw new Error("找不到 minimax-cn/MiniMax-M3");
  const { session } = await createAgentSession({
    cwd,
    model: MODEL,
    authStorage: AuthStorage.create(),
    sessionManager: SessionManager.inMemory(),
    tools: [],
    thinkingLevel: "minimal",
  });

  let text: string;
  try {
    await session.prompt(`你是 Git 提交审查器。不要执行命令或修改文件。
根据用户意图选择相关文件，生成简短的 Conventional Commit message。
只返回 JSON：{"files":["path"],"message":"type: summary","reason":"..."}
用户意图：${request}
可选文件：\n${available.join("\n")}
Git diff${diff.length > DIFF_LIMIT ? "（已截断）" : ""}：\n${diff.slice(0, DIFF_LIMIT)}`);
    text = responseText(session.messages);
  } finally {
    session.dispose();
  }

  const data = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
  const allowed = new Set(available);
  const files = Array.isArray(data.files)
    ? [...new Set<string>(data.files.filter((file: unknown): file is string => typeof file === "string" && allowed.has(file)))]
    : [];
  const message = typeof data.message === "string" ? data.message.trim() : "";
  if (!files.length) throw new Error("AI 没有选择有效文件");
  if (!message) throw new Error("AI 没有生成提交信息");

  return {
    files,
    message,
    reason: String(data.reason ?? ""),
    snapshot: await changes(pi, cwd, files),
  };
}

async function commit(pi: ExtensionAPI, cwd: string, push: boolean) {
  const item = pending.get(cwd);
  if (!item) throw new Error("没有待确认的 Git 提交");
  if (await changes(pi, cwd, item.files) !== item.snapshot) {
    pending.delete(cwd);
    throw new Error("文件已发生变化，请重新审查");
  }

  await git(pi, cwd, ["add", "--", ...item.files]);
  await git(pi, cwd, ["commit", "--only", "-m", item.message, "--", ...item.files]);
  pending.delete(cwd);
  if (push) await git(pi, cwd, ["push"]);
  return push ? `已提交并推送：${item.message}` : `已提交：${item.message}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git-ai", {
    description: "AI 分析 Git 修改并生成提交信息",
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify("正在分析 Git 修改…", "info");
        const result = await review(pi, ctx.cwd, args.trim() || "分析全部 Git 修改的代码");
        pending.set(ctx.cwd, result);
        const summary = await stats(pi, ctx.cwd, result.files);
        ctx.ui.notify(
          `${result.message}\n\n${result.reason}\n\n文件变更：\n${summary}\n\n确认：/git yes（提交）或 /git push（提交并推送）`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("git", {
    description: "执行 Git 命令",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command === "yes") {
          ctx.ui.notify(await commit(pi, ctx.cwd, false), "info");
          return;
        }
        if (command === "push") {
          if (pending.has(ctx.cwd)) {
            ctx.ui.notify(await commit(pi, ctx.cwd, true), "info");
          } else {
            await git(pi, ctx.cwd, ["push"]);
            ctx.ui.notify("已推送到远端。", "info");
          }
          return;
        }
        if (command === "append") {
          await git(pi, ctx.cwd, ["add", "-A"]);
          await git(pi, ctx.cwd, ["commit", "--amend", "--no-edit"]);
          ctx.ui.notify("已追加到上一次提交。", "info");
          return;
        }
        const output = await git(pi, ctx.cwd, command ? command.split(/\s+/) : ["status", "--short"]);
        ctx.ui.notify(output || "完成。", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
