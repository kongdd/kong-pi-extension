/**
 * 查询各 AI 服务的额度：/quota
 *
 * 复用系统中的 ai-quota 命令，避免在扩展中重复维护额度接口和解析逻辑。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 10_000;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("quota", {
    description: "查询 AI 额度（调用系统 ai-quota）",
    handler: async (_args, ctx) => {
      const result = await pi.exec("ai-quota", [], { timeout: TIMEOUT_MS });
      const output = (result.stdout || result.stderr).trim();

      if (result.code !== 0 || !output) {
        ctx.ui.notify(
          `ai-quota 执行失败${output ? `：${output}` : ""}`,
          "error",
        );
        return;
      }

      ctx.ui.notify(`AI 额度\n\n${output}`, "info");
    },
  });
}
