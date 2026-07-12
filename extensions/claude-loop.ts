/**
 * Claude Loop for pi
 *
 * A local implementation of Claude Code's /loop and scheduled-task workflow.
 * Tasks are session-scoped, restored from ~/.pi/agent/loops.json, and only fire
 * while the pi session is running and idle.
 *
 * Commands:
 *   /loop [interval] <prompt>   Create a recurring task (e.g. /loop 5m check CI)
 *   /loop <prompt>              Recurring task with a 20-minute default interval
 *   /loop                       Use .pi/loop.md or ~/.pi/agent/loop.md
 *   /cron list                  List tasks
 *   /cron cancel <id>           Cancel a task
 *   /cron remind <duration> <prompt>  Create a one-shot reminder
 */

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const STORE_PATH = join(homedir(), ".pi", "agent", "loops.json");
const DEFAULT_INTERVAL_MS = 20 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 60_000;
const MAX_TASKS = 50;
const TASK_TTL_MS = 7 * 86_400_000;

// Deliberately close to Claude Code's persisted task shape, while adding pi's
// session key so tasks do not leak into another conversation.
type StoredTask = {
  id: string;
  session: string;
  cwd: string;
  prompt: string;
  schedule: { kind: "interval" | "once"; intervalMs?: number; at?: string };
  createdAt: string;
  nextRunAt: string;
};

type Store = { version: 1; tasks: StoredTask[] };

function makeId(tasks: StoredTask[]): string {
  let id = "";
  do id = Math.random().toString(36).slice(2, 10); while (tasks.some((task) => task.id === id));
  return id;
}

function parseDuration(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase() as "s" | "m" | "h" | "d"];
  // Claude's scheduler has one-minute granularity.
  return Math.max(MIN_INTERVAL_MS, Math.ceil(amount * unit / MIN_INTERVAL_MS) * MIN_INTERVAL_MS);
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

async function loadStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, "utf8")) as Partial<Store>;
    if (parsed.version === 1 && Array.isArray(parsed.tasks)) return { version: 1, tasks: parsed.tasks };
  } catch { /* Missing or invalid storage is treated as an empty scheduler. */ }
  return { version: 1, tasks: [] };
}

async function saveStore(store: Store): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const temporary = `${STORE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STORE_PATH);
}

async function readDefaultPrompt(cwd: string): Promise<string> {
  const candidates = [join(cwd, ".pi", "loop.md"), join(homedir(), ".pi", "agent", "loop.md")];
  for (const path of candidates) {
    try {
      await access(path);
      const prompt = (await readFile(path, "utf8")).trim();
      if (prompt) return prompt;
    } catch { /* Try the next scope. */ }
  }
  return "Review the current session, continue the authorized work, and report what remains. Do not start unrelated work.";
}

function usage(ctx: ExtensionCommandContext): void {
  ctx.ui.notify("用法：/loop [5m] <prompt>；/cron list；/cron cancel <id>；/cron remind 1h <prompt>", "info");
}

export default function claudeLoop(pi: ExtensionAPI): void {
  let currentCtx: ExtensionCommandContext | undefined;
  let sessionKey = "";
  let cwd = process.cwd();
  let store: Store = { version: 1, tasks: [] };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let shuttingDown = false;

  function sessionTasks(): StoredTask[] {
    return store.tasks.filter((task) => task.session === sessionKey && task.cwd === cwd);
  }

  function renderStatus(): void {
    if (!currentCtx?.hasUI) return;
    const count = sessionTasks().length;
    currentCtx.ui.setStatus("claude-loop", count ? `◷ ${count} scheduled` : undefined);
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }

  async function persist(): Promise<void> {
    try { await saveStore(store); } catch (error) {
      currentCtx?.ui.notify(`无法保存定时任务：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  function schedule(task: StoredTask): void {
    clearTimer(task.id);
    const delay = Math.max(0, new Date(task.nextRunAt).getTime() - Date.now());
    timers.set(task.id, setTimeout(() => void fire(task.id), delay));
  }

  async function fire(id: string): Promise<void> {
    if (shuttingDown) return;
    const task = store.tasks.find((candidate) => candidate.id === id);
    if (!task || task.session !== sessionKey || task.cwd !== cwd) return;

    if (!currentCtx || !currentCtx.isIdle()) {
      task.nextRunAt = new Date(Date.now() + RETRY_INTERVAL_MS).toISOString();
      await persist();
      schedule(task);
      return;
    }

    clearTimer(id);
    if (task.schedule.kind === "once") {
      store.tasks = store.tasks.filter((candidate) => candidate.id !== id);
    } else {
      task.nextRunAt = new Date(Date.now() + (task.schedule.intervalMs ?? DEFAULT_INTERVAL_MS)).toISOString();
    }
    await persist();
    renderStatus();

    try {
      pi.sendUserMessage(`[Scheduled task ${task.id}] ${task.prompt}`);
    } catch (error) {
      currentCtx.ui.notify(`定时任务 ${task.id} 执行失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    if (task.schedule.kind === "interval" && store.tasks.includes(task)) schedule(task);
  }

  function listTasks(): void {
    const tasks = sessionTasks();
    if (!tasks.length) {
      currentCtx?.ui.notify("当前会话没有定时任务。", "info");
      return;
    }
    const text = tasks.map((task) => {
      const cadence = task.schedule.kind === "once" ? "once" : `every ${formatDuration(task.schedule.intervalMs ?? DEFAULT_INTERVAL_MS)}`;
      return `${task.id}  ${cadence}  next ${task.nextRunAt}  ${task.prompt}`;
    }).join("\n");
    currentCtx?.ui.notify(text, "info");
  }

  async function createTask(prompt: string, intervalMs: number | undefined, once: boolean): Promise<void> {
    if (!prompt.trim()) { usage(currentCtx!); return; }
    const tasks = sessionTasks();
    if (tasks.length >= MAX_TASKS) {
      currentCtx?.ui.notify(`最多只能创建 ${MAX_TASKS} 个任务。`, "warning");
      return;
    }
    const now = new Date();
    const task: StoredTask = {
      id: makeId(store.tasks), session: sessionKey, cwd, prompt: prompt.trim(),
      schedule: once ? { kind: "once", at: new Date(now.getTime() + (intervalMs ?? DEFAULT_INTERVAL_MS)).toISOString() } : { kind: "interval", intervalMs: intervalMs ?? DEFAULT_INTERVAL_MS },
      createdAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + (intervalMs ?? DEFAULT_INTERVAL_MS)).toISOString(),
    };
    store.tasks.push(task);
    await persist();
    schedule(task);
    renderStatus();
    currentCtx?.ui.notify(`已创建任务 ${task.id}（${once ? "一次性" : `每 ${formatDuration(intervalMs ?? DEFAULT_INTERVAL_MS)}`}）。`, "info");
  }

  async function cancelTask(id: string): Promise<void> {
    const task = store.tasks.find((candidate) => candidate.id === id && candidate.session === sessionKey && candidate.cwd === cwd);
    if (!task) { currentCtx?.ui.notify(`找不到任务 ${id}。`, "warning"); return; }
    clearTimer(id);
    store.tasks = store.tasks.filter((candidate) => candidate.id !== id);
    await persist();
    renderStatus();
    currentCtx?.ui.notify(`已取消任务 ${id}。`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    cwd = ctx.cwd;
    sessionKey = ctx.sessionManager.getSessionFile() ?? `ephemeral:${cwd}`;
    shuttingDown = false;
    store = await loadStore();
    // Match Claude Code's seven-day expiry for recurring loops. One-shot tasks
    // survive a restart only while their scheduled time is still in the future.
    const now = Date.now();
    store.tasks = store.tasks.filter((task) => {
      if (task.schedule.kind === "interval") return now - new Date(task.createdAt).getTime() < TASK_TTL_MS;
      return new Date(task.nextRunAt).getTime() > now;
    });
    await persist();
    for (const task of sessionTasks()) schedule(task);
    renderStatus();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });

  pi.registerCommand("loop", {
    description: "创建循环定时任务：/loop [5m] <prompt>",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const input = args.trim();
      if (!input) return createTask(await readDefaultPrompt(ctx.cwd), undefined, false);
      const parts = input.split(/\s+/);
      const interval = parseDuration(parts[0]);
      await createTask(interval ? input.slice(parts[0].length).trim() : input, interval, false);
    },
  });

  pi.registerCommand("cron", {
    description: "管理定时任务：list|cancel|remind",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts.shift()?.toLowerCase() ?? "list";
      if (action === "list") return listTasks();
      if (action === "cancel" || action === "delete") return cancelTask(parts[0] ?? "");
      if (action === "remind") {
        const interval = parseDuration(parts[0] ?? "");
        if (!interval) return usage(ctx);
        return createTask(parts.slice(1).join(" "), interval, true);
      }
      usage(ctx);
    },
  });
}
