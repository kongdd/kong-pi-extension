/**
 * Short extension — 提醒 LLM 用简短凝练的语言回答。
 *
 * 思路同 /caveman skill，改为注册为运行时上下文，每 turn 生效。
 * 切换：/short [on|off]   （默认 on）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REMINDER = [
  "输出要极其克制，言简意赅，以极其简短、凝练的语言回答问题；",
  "代码编写尽可能简短，但排版要符合规范，不能牺牲代码的易读性。遵循Linux极简主义，一次做好一件事；",
].join("\n");

export default function (pi: ExtensionAPI) {
  let enabled = true;

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${REMINDER}` };
  });

  pi.registerCommand("short", {
    description: "短答模式（/short [on|off]）",
    handler: async (args, ctx) => {
      const arg = args.trim().split(/\s+/)[0]?.toLowerCase();
      if (arg === "off") enabled = false;
      else if (arg === "on") enabled = true;
      else if (arg) return;
      else enabled = !enabled;
      ctx.ui.notify(`短答：${enabled ? "开" : "关"}`, "info");
    },
  });
}
