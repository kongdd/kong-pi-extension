import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadFridayConfig, saveFridayConfig } from "../config";
import friday from "../index";

let root: string;
let cwd: string;
const envKeys = ["PI_CONFIG_DIR", "FRIDAY_REMOTE", "FRIDAY_ENABLE_SSE"] as const;
let previousEnv: Array<string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-friday-"));
  cwd = join(root, "project");
  mkdirSync(cwd);
  previousEnv = envKeys.map((key) => process.env[key]);
  process.env.PI_CONFIG_DIR = join(root, "config");
  process.env.FRIDAY_REMOTE = "0";
  delete process.env.FRIDAY_ENABLE_SSE;
});

afterEach(() => {
  envKeys.forEach((key, i) => {
    if (previousEnv[i] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[i];
  });
  rmSync(root, { recursive: true, force: true });
});

const globalPath = () => join(process.env.PI_CONFIG_DIR!, "Friday.json");
const localPath = () => join(cwd, ".pi", "Friday.json");

function runtime(execCode = 0) {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
  const messages: string[] = [];
  const executions: string[] = [];
  let status: string | undefined;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => messages.push(message),
      setStatus: (_key: string, text: string | undefined) => { status = text; },
    },
  } as unknown as ExtensionCommandContext;
  friday({
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => handlers.set(name, handler),
    registerCommand: (_name: string, registered: typeof command) => { command = registered; },
    exec: async (name: string) => {
      executions.push(name);
      return { code: execCode, stdout: "", stderr: "" };
    },
  } as unknown as ExtensionAPI);
  return {
    run: (args: string) => command.handler(args, ctx),
    start: () => handlers.get("session_start")!({}, ctx),
    complete: (prefix: string) => command.getArgumentCompletions!(prefix),
    get status() { return status; },
    messages,
    executions,
  };
}

test("缺省不写文件，保持原有自动开关", async () => {
  expect(loadFridayConfig(cwd).enabled).toBeUndefined();
  const app = runtime();
  await app.start();
  expect(app.status).toBe("○ Friday off");
  expect(existsSync(globalPath())).toBe(false);
  expect(existsSync(localPath())).toBe(false);
});

test("项目开关覆盖全局，其他项目继承全局", async () => {
  await saveFridayConfig({ enabled: true, saveAudio: true, mode: "local" });
  await saveFridayConfig({ enabled: false }, "local", cwd);
  expect(loadFridayConfig(cwd)).toEqual({ enabled: false, saveAudio: true, mode: "local" });
  expect(loadFridayConfig(root).enabled).toBe(true);
  expect(JSON.parse(readFileSync(localPath(), "utf8"))).toEqual({ enabled: false });
  await saveFridayConfig({ enabled: false });
  await saveFridayConfig({ enabled: true }, "local", cwd);
  expect(loadFridayConfig(cwd).enabled).toBe(true);
  expect(loadFridayConfig(root).enabled).toBe(false);
});

test("保存开关与音频配置时保留其他字段", async () => {
  await saveFridayConfig({ mode: "remote", saveAudio: true });
  await saveFridayConfig({ enabled: false });
  await saveFridayConfig({ saveAudio: false });
  expect(loadFridayConfig()).toEqual({ enabled: false, saveAudio: false, mode: "remote" });
});

test("无效项目开关回退到全局", async () => {
  await saveFridayConfig({ enabled: true });
  mkdirSync(join(cwd, ".pi"));
  for (const value of ['{"enabled":"false"}', "null", "{broken"]) {
    writeFileSync(localPath(), value);
    expect(loadFridayConfig(cwd).enabled).toBe(true);
  }
});

test.each(["global", "local"] as const)("on/off %s 持久化并在新会话恢复", async (scope) => {
  const app = runtime();
  await app.start();
  await app.run(`on ${scope}`);
  expect(app.status).toBe("● Friday zh");
  const path = scope === "global" ? globalPath() : localPath();
  expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(true);
  const reloaded = runtime();
  await reloaded.start();
  expect(reloaded.status).toBe("● Friday zh");
  expect(reloaded.executions).toEqual(["uvx", "sh"]);
  await reloaded.run(`off ${scope}`);
  expect(reloaded.status).toBe("○ Friday off");
  const next = runtime();
  await next.start();
  expect(next.status).toBe("○ Friday off");
  expect(next.executions).toEqual([]);
});

test("无范围开关仅影响当前会话", async () => {
  const app = runtime();
  await app.start();
  await app.run("on");
  expect(app.status).toBe("● Friday zh");
  await app.run("off");
  expect(app.status).toBe("○ Friday off");
  expect(existsSync(globalPath())).toBe(false);
  expect(existsSync(localPath())).toBe(false);
});

test("修改全局时仍尊重项目覆盖", async () => {
  await saveFridayConfig({ enabled: false }, "local", cwd);
  const app = runtime();
  await app.start();
  await app.run("on global");
  expect(loadFridayConfig().enabled).toBe(true);
  expect(app.status).toBe("○ Friday off");
});

test("远程默认开启可被持久化关闭", async () => {
  process.env.FRIDAY_REMOTE = "1";
  await saveFridayConfig({ enabled: false });
  const app = runtime();
  await app.start();
  expect(app.status).toBe("○ Friday off");
  expect(app.executions).toEqual([]);
});

test("初始化失败保持关闭", async () => {
  await saveFridayConfig({ enabled: true });
  const app = runtime(1);
  await app.start();
  expect(app.status).toBe("○ Friday off");
  expect(app.messages.some((message) => message.includes("无法开启"))).toBe(true);
});

test("保存失败不改变当前开关", async () => {
  const app = runtime();
  await app.start();
  await app.run("on");
  writeFileSync(join(cwd, ".pi"), "blocked");
  await app.run("off local");
  expect(app.status).toBe("● Friday zh");
  expect(app.messages.at(-1)).toContain("配置保存失败");
});

test("补全范围并拒绝无效参数", async () => {
  const app = runtime();
  expect(app.complete("on ")?.map((item) => item.value)).toContain("on global");
  expect(app.complete("off l")?.map((item) => item.value)).toEqual(["off local"]);
  await app.run("on invalid");
  expect(app.messages.at(-1)).toContain("格式：");
  expect(existsSync(globalPath())).toBe(false);
});
