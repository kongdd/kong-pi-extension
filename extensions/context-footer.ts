import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Inlined from pi-coding-agent's FooterComponent (v0.80.6) to avoid a
// forbidden deep import — the package's `exports` field does not expose
// `dist/modes/interactive/components/footer.js`.
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export default function contextFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footer) => {
      const dispose = footer.onBranchChange(() => tui.requestRender());

      return {
        dispose,
        invalidate() {},
        render(width: number): string[] {
          let input = 0;
          let output = 0;
          let read = 0;
          let write = 0;
          let cost = 0;
          let cacheHit: number | undefined;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "message" || entry.message.role !== "assistant") continue;
            const usage = entry.message.usage;
            input += usage.input;
            output += usage.output;
            read += usage.cacheRead;
            write += usage.cacheWrite;
            cost += usage.cost.total;
            const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
            cacheHit = prompt ? usage.cacheRead / prompt * 100 : undefined;
          }

          const stats = [
            input && `↑${formatTokens(input)}`,
            output && `↓${formatTokens(output)}`,
            read && `R${formatTokens(read)}`,
            write && `W${formatTokens(write)}`,
            (read || write) && cacheHit !== undefined && `CH${cacheHit.toFixed(1)}%`,
          ].filter(Boolean);

          const subscription = ctx.model
            ? ctx.modelRegistry.isUsingOAuth(ctx.model)
            : false;
          if (cost || subscription) {
            stats.push(`$${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
          }

          const usage = ctx.getContextUsage();
          const used = usage?.tokens == null ? "?" : formatTokens(usage.tokens);
          const limit = formatTokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0);
          const context = `${used}/${limit}`;
          const contextColor = (usage?.percent ?? 0) > 90
            ? "error"
            : (usage?.percent ?? 0) > 70 ? "warning" : "dim";
          let left = theme.fg("dim", stats.join(" "));
          if (stats.length) left += " ";
          left += theme.fg(contextColor, context);

          const model = ctx.model?.id ?? "no-model";
          const thinking = pi.getThinkingLevel();
          let right = ctx.model?.reasoning
            ? `${model} • ${thinking === "off" ? "thinking off" : thinking}`
            : model;
          if (footer.getAvailableProviderCount() > 1 && ctx.model) {
            right = `(${ctx.model.provider}) ${right}`;
          }

          if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
          const room = width - visibleWidth(left) - 2;
          right = room > 0 ? truncateToWidth(right, room, "") : "";
          const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));

          let cwd = formatCwdForFooter(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
          const branch = footer.getGitBranch();
          if (branch) cwd += ` (${branch})`;
          const name = ctx.sessionManager.getSessionName();
          if (name) cwd += ` • ${name}`;

          const lines = [
            truncateToWidth(theme.fg("dim", cwd), width, theme.fg("dim", "...")),
            left + theme.fg("dim", gap + right),
          ];
          const statuses = [...footer.getExtensionStatuses()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/\s+/g, " ").trim());
          if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width));

          return lines;
        },
      };
    });
  });
}
