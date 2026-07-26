/**
 * Short extension — 默认注入系统提示；/short 时额外嵌入本轮 user message。
 *
 * 用法：
 *   /short on|off     开关系统提示注入（默认 on）
 *   /short <问题>     发送带短答约束的 user message
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
    description: "短答：/short on|off | /short <问题>",
    handler: async (args, ctx) => {
      const text = args.trim();
      const head = text.split(/\s+/)[0]?.toLowerCase();

      if (head === "on" || head === "off") {
        enabled = head === "on";
        ctx.ui.notify(`短答系统提示：${enabled ? "开" : "关"}`, "info");
        return;
      }

      if (!text) {
        ctx.ui.notify("用法：/short on|off | /short <问题>", "warning");
        return;
      }
      await pi.sendUserMessage(`${text}\n\n${REMINDER}`);
    },
  });
}
