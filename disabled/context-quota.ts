/**
 * 查询当前会话 context 占用：/ctx
 *
 * 通过 ctx.ui.notify 弹出，不写入提示词 context，类比 /quota。
 * 字段口径与 extensions/context-footer.ts 对齐。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function fmtPercent(p: number): string {
  return `${p.toFixed(1)}%`;
}

function bar(p: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(p / 100 * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ctx", {
    description: "查询当前会话 context 占用（通知，不占提示词）",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const model = ctx.model;
      const limit = usage?.contextWindow ?? model?.contextWindow ?? 0;
      const used = usage?.tokens ?? 0;
      const percent = usage?.percent ?? 0;

      // 累计统计：与 context-footer 一致
      let input = 0, output = 0, read = 0, write = 0, cost = 0;
      for (const e of ctx.sessionManager.getEntries()) {
        if (e.type !== "message" || e.message.role !== "assistant") continue;
        const u = e.message.usage;
        input += u.input;
        output += u.output;
        read += u.cacheRead;
        write += u.cacheWrite;
        cost += u.cost.total;
      }
      const prompt = input + read + write;
      const cacheHit = prompt ? (read / prompt) * 100 : 0;
      const subscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;

      const sessionName = ctx.sessionManager.getSessionName();
      const thinking = pi.getThinkingLevel();
      const modelStr = model
        ? (model.reasoning
          ? `${model.id} · ${thinking === "off" ? "thinking off" : thinking}`
          : model.id)
        : "no-model";

      const stats = [
        input && `↑${fmtTokens(input)}`,
        output && `↓${fmtTokens(output)}`,
        read && `R${fmtTokens(read)}`,
        write && `W${fmtTokens(write)}`,
        cacheHit ? `CH${fmtPercent(cacheHit)}` : "",
      ].filter(Boolean).join(" ");

      const costStr = (cost || subscription)
        ? `$${cost.toFixed(4)}${subscription ? " (sub)" : ""}`
        : "";

      const lines = [
        sessionName ? `会话 · ${sessionName}` : "会话",
        `路径: ${ctx.cwd}`,
        `模型: ${modelStr}`,
        "",
        `Context  [${bar(percent)}]  ${fmtPercent(percent)}`,
        `         ${fmtTokens(used)} / ${fmtTokens(limit)}  (剩余 ${fmtPercent(100 - percent)})`,
        "",
        stats ? `累计 ${stats}  ${costStr}`.trim() : `累计  ${costStr}`.trim(),
      ];

      const level = percent > 90 ? "error" : percent > 70 ? "warning" : "info";
      ctx.ui.notify(lines.join("\n"), level);
    },
  });
}
