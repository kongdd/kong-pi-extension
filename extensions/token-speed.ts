import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS = "token-speed";
const MIN_SAMPLE_MS = 500;
const UPDATE_MS = 300;

export default function tokenSpeed(pi: ExtensionAPI): void {
  let startedAt = 0;
  let lastUpdate = 0;
  let chars = 0;

  const reset = (ctx: ExtensionContext) => {
    startedAt = 0;
    lastUpdate = 0;
    chars = 0;
    ctx.ui.setStatus(STATUS, undefined);
  };

  const update = (ctx: ExtensionContext, force = false) => {
    const now = Date.now();
    const elapsed = now - startedAt;
    if (!startedAt || !chars || !elapsed) return;
    if (!force && (elapsed < MIN_SAMPLE_MS || now - lastUpdate < UPDATE_MS)) return;

    const speed = chars * 250 / elapsed; // pi-web: ~4 chars/token
    const color = speed >= 50 ? "accent" : speed >= 30 ? "success" : speed >= 15 ? "warning" : "error";
    ctx.ui.setStatus(STATUS, ctx.ui.theme.fg(color, `${speed.toFixed(1)} t/s`));
    lastUpdate = now;
  };

  pi.on("session_start", (_event, ctx) => reset(ctx));

  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant") reset(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    const stream = event.assistantMessageEvent;
    if (stream.type !== "text_delta" && stream.type !== "thinking_delta" && stream.type !== "toolcall_delta") return;

    if (!startedAt) startedAt = Date.now();
    chars += stream.delta.length;
    update(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") update(ctx, true);
  });
}
