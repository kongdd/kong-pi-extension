import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS = "ai-quota";
const PROVIDERS: Record<string, string> = {
  openai: "openai",
  "openai-codex": "openai",
  xai: "grok",
  grok: "grok",
  "grok-cli": "grok",
  "grok-build": "grok",
  minimax: "minimax",
  "minimax-cn": "minimax",
  deepseek: "deepseek",
  "deepseek-api": "deepseek",
  "github-copilot": "github-copilot",
};

// Read the compact report, retaining ai-quota's exact ANSI colors and rounding.
// Join available windows as 5h%/wk%/mo%; single-pool providers show one percentage.
// Grok's first column is a weekly pool, not a five-hour window.
function quotaCell(report: string, provider: string): string | undefined {
  let selected = false;
  const cells: string[] = [];
  let duration = "";
  for (const line of report.split("\n")) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (plain && !/^\s/.test(plain)) {
      if (cells.length) break;
      const name = plain.replace(/\s*·\s*/g, "·").toLowerCase();
      selected = provider === "openai"
        ? name === "openai·apps"
        : provider === "openai-codex"
          ? /^codex(?:·|$)/.test(name)
          : name.startsWith(provider === "github-copilot" ? "gh-copilot" : provider);
    } else if (selected && provider === "deepseek" && /^\s+bal\s/.test(plain)) {
      return line.replace(/^\s+bal\s+/, "").trim() || undefined;
    } else if (selected && provider !== "deepseek" && /^\s+(?:5h|wk|mo)\s/.test(plain)) {
      const match = line.match(/((?:\x1b\[[0-9;]*m)?\s*\d+%(?:\x1b\[[0-9;]*m)?)\s+(.+)$/);
      if (!match) continue;
      cells.push(match[1]!.replace(/ /g, ""));
      if (!duration) {
        duration = match[2]!.replace(/(\d+)d\s+(\d+)h\s+(\d+)m/, (time, days, hours, minutes) =>
          Number(days) > 2 || (Number(days) === 2 && Number(hours) + Number(minutes) > 0)
            ? `${days}d`
            : time,
        );
      }
    }
  }
  return cells.length ? `${cells.join("/")} ↻ ${duration}` : undefined;
}

export default function quotaFooter(pi: ExtensionAPI): void {
  let pending: AbortController | undefined;

  const clear = (ctx: ExtensionContext) => {
    pending?.abort();
    pending = undefined;
    ctx.ui.setStatus(STATUS, undefined);
  };

  const refresh = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    clear(ctx);

    const modelProvider = ctx.model?.provider ?? "";
    const provider = PROVIDERS[modelProvider];
    if (!provider) return;

    const request = new AbortController();
    pending = request;
    let text = ctx.ui.theme.fg("dim", `${provider} n/a`);
    try {
      const args = ["FORCE_COLOR=1", "ai-quota", "-p", provider === "deepseek" ? "deepseek-api" : provider, "--compact"];
      if (modelProvider === "minimax") args.push("--region", "intl");
      const result = await pi.exec("env", args, {
        cwd: ctx.cwd,
        signal: request.signal,
        timeout: 45_000,
      });
      const cell = result.code === 0 && !result.killed
        ? quotaCell(result.stdout, modelProvider === "openai-codex" ? modelProvider : provider)
        : undefined;
      if (cell) text = `${provider} ${cell}`;
    } catch {
      // Missing CLI, credentials or network: no transcript noise or stale quota.
    }
    if (!request.signal.aborted && pending === request) {
      ctx.ui.setStatus(STATUS, text);
      pending = undefined;
    }
  };

  // Query at startup, on model changes and after each settled conversation; no polling.
  pi.on("agent_settled", (_event, ctx) => { void refresh(ctx); });
  pi.on("session_start", (_event, ctx) => { void refresh(ctx); });
  pi.on("model_select", (_event, ctx) => { void refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
}
