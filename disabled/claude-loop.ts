/**
 * Claude Loop for pi — session-scoped scheduled tasks.
 *
 *   /loop [interval] <prompt>   recurring (default 20m)
 *   /loop                       .pi/loop.md or ~/.pi/agent/loop.md
 *   /cron list | cancel <id> | remind <duration> <prompt>
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const STORE = join(homedir(), ".pi", "agent", "loops.json");
const DEFAULT_MS = 20 * 60_000;
const MIN_MS = 60_000;
const RETRY_MS = 60_000;
const MAX_TASKS = 50;
const TTL_MS = 7 * 86_400_000;
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

type Task = {
  id: string;
  session: string;
  cwd: string;
  prompt: string;
  schedule: { kind: "interval" | "once"; intervalMs?: number; at?: string };
  createdAt: string;
  nextRunAt: string;
};

type Store = { version: 1; tasks: Task[] };

function parseDuration(v: string): number | undefined {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!m) return;
  const ms = Number(m[1]) * UNIT[m[2].toLowerCase()]!;
  return Math.max(MIN_MS, Math.ceil(ms / MIN_MS) * MIN_MS);
}

function fmt(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

async function load(): Promise<Store> {
  try {
    const p = JSON.parse(await readFile(STORE, "utf8")) as Partial<Store>;
    if (p.version === 1 && Array.isArray(p.tasks)) return { version: 1, tasks: p.tasks };
  } catch { /* empty */ }
  return { version: 1, tasks: [] };
}

async function save(store: Store): Promise<void> {
  await mkdir(dirname(STORE), { recursive: true });
  const tmp = `${STORE}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, STORE);
}

async function defaultPrompt(cwd: string): Promise<string> {
  for (const p of [join(cwd, ".pi", "loop.md"), join(homedir(), ".pi", "agent", "loop.md")]) {
    try {
      const t = (await readFile(p, "utf8")).trim();
      if (t) return t;
    } catch { /* next */ }
  }
  return "Review the current session, continue the authorized work, and report what remains. Do not start unrelated work.";
}

function usage(ctx: ExtensionCommandContext): void {
  ctx.ui.notify("用法：/loop [5m] <prompt>；/cron list；/cron cancel <id>；/cron remind 1h <prompt>", "info");
}

export default function claudeLoop(pi: ExtensionAPI): void {
  let ctx: ExtensionCommandContext | undefined;
  let session = "";
  let cwd = process.cwd();
  let store: Store = { version: 1, tasks: [] };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let down = false;

  const mine = () => store.tasks.filter((t) => t.session === session && t.cwd === cwd);
  const status = () => {
    if (!ctx?.hasUI) return;
    const n = mine().length;
    ctx.ui.setStatus("claude-loop", n ? `◷ ${n} scheduled` : undefined);
  };
  const untimer = (id: string) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  };
  const persist = async () => {
    try { await save(store); }
    catch (e) { ctx?.ui.notify(`无法保存定时任务：${e instanceof Error ? e.message : String(e)}`, "error"); }
  };

  const schedule = (task: Task) => {
    untimer(task.id);
    const delay = Math.max(0, +new Date(task.nextRunAt) - Date.now());
    timers.set(task.id, setTimeout(() => void fire(task.id), delay));
  };

  async function fire(id: string): Promise<void> {
    if (down) return;
    const task = store.tasks.find((t) => t.id === id);
    if (!task || task.session !== session || task.cwd !== cwd) return;

    if (!ctx?.isIdle()) {
      task.nextRunAt = new Date(Date.now() + RETRY_MS).toISOString();
      await persist();
      schedule(task);
      return;
    }

    untimer(id);
    if (task.schedule.kind === "once") {
      store.tasks = store.tasks.filter((t) => t.id !== id);
    } else {
      task.nextRunAt = new Date(Date.now() + (task.schedule.intervalMs ?? DEFAULT_MS)).toISOString();
    }
    await persist();
    status();

    try { pi.sendUserMessage(`[Scheduled task ${task.id}] ${task.prompt}`); }
    catch (e) { ctx.ui.notify(`定时任务 ${task.id} 执行失败：${e instanceof Error ? e.message : String(e)}`, "error"); }

    if (task.schedule.kind === "interval" && store.tasks.includes(task)) schedule(task);
  }

  async function create(prompt: string, intervalMs: number | undefined, once: boolean): Promise<void> {
    if (!prompt.trim()) return usage(ctx!);
    if (mine().length >= MAX_TASKS) return void ctx?.ui.notify(`最多只能创建 ${MAX_TASKS} 个任务。`, "warning");

    const ms = intervalMs ?? DEFAULT_MS;
    const now = new Date();
    const at = new Date(+now + ms).toISOString();
    const task: Task = {
      id: randomUUID().slice(0, 8),
      session, cwd, prompt: prompt.trim(),
      schedule: once ? { kind: "once", at } : { kind: "interval", intervalMs: ms },
      createdAt: now.toISOString(),
      nextRunAt: at,
    };
    store.tasks.push(task);
    await persist();
    schedule(task);
    status();
    ctx?.ui.notify(`已创建任务 ${task.id}（${once ? "一次性" : `每 ${fmt(ms)}`}）。`, "info");
  }

  async function cancel(id: string): Promise<void> {
    const task = mine().find((t) => t.id === id);
    if (!task) return void ctx?.ui.notify(`找不到任务 ${id}。`, "warning");
    untimer(id);
    store.tasks = store.tasks.filter((t) => t.id !== id);
    await persist();
    status();
    ctx?.ui.notify(`已取消任务 ${id}。`, "info");
  }

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    cwd = c.cwd;
    session = c.sessionManager.getSessionFile() ?? `ephemeral:${cwd}`;
    down = false;
    store = await load();
    const now = Date.now();
    store.tasks = store.tasks.filter((t) =>
      t.schedule.kind === "interval"
        ? now - +new Date(t.createdAt) < TTL_MS
        : +new Date(t.nextRunAt) > now,
    );
    await persist();
    for (const t of mine()) schedule(t);
    status();
  });

  pi.on("session_shutdown", async () => {
    down = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });

  pi.registerCommand("loop", {
    description: "创建循环定时任务：/loop [5m] <prompt>",
    handler: async (args, c) => {
      ctx = c;
      const input = args.trim();
      if (!input) return create(await defaultPrompt(c.cwd), undefined, false);
      const [head] = input.split(/\s+/);
      const interval = parseDuration(head);
      await create(interval ? input.slice(head.length).trim() : input, interval, false);
    },
  });

  pi.registerCommand("cron", {
    description: "管理定时任务：list|cancel|remind",
    handler: async (args, c) => {
      ctx = c;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts.shift() ?? "list").toLowerCase();
      if (action === "list") {
        const tasks = mine();
        if (!tasks.length) return void ctx?.ui.notify("当前会话没有定时任务。", "info");
        const text = tasks.map((t) => {
          const cadence = t.schedule.kind === "once" ? "once" : `every ${fmt(t.schedule.intervalMs ?? DEFAULT_MS)}`;
          return `${t.id}  ${cadence}  next ${t.nextRunAt}  ${t.prompt}`;
        }).join("\n");
        return void ctx?.ui.notify(text, "info");
      }
      if (action === "cancel" || action === "delete") return cancel(parts[0] ?? "");
      if (action === "remind") {
        const interval = parseDuration(parts[0] ?? "");
        if (!interval) return usage(c);
        return create(parts.slice(1).join(" "), interval, true);
      }
      usage(c);
    },
  });
}
