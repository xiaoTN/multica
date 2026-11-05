// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureLocalRuntime } from "./local-runtime";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-team-runtime-"));
  dirs.push(dataDir);
  return { dataDir, resourcesDir: "/test/resources", apiUrl: "http://127.0.0.1:8080", appUrl: "http://127.0.0.1:3000" };
}

it("默认后台不可用时自动准备数据库、迁移并启动后台，重启沿用同一份数据", async () => {
  const options = await setup();
  let ready = false;
  let containerExists = false;
  const order: string[] = [];
  const command = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "container" && !containerExists) throw new Error("尚未创建");
    if (args[0] === "run") { containerExists = true; order.push("数据库"); }
    if (args[0] === "up") order.push("迁移");
    return "ok";
  });
  const startServer = vi.fn(async () => { order.push("后台"); ready = true; });
  const dependencies = { command, startServer, probe: async () => ready };
  await ensureLocalRuntime({ ...options, dependencies });
  expect(order).toEqual(["数据库", "迁移", "后台"]);
  const settings = await readFile(join(options.dataDir, "runtime.json"), "utf8");
  expect(JSON.parse(settings).password).toHaveLength(64);

  ready = false;
  await ensureLocalRuntime({ ...options, dependencies });
  expect(await readFile(join(options.dataDir, "runtime.json"), "utf8")).toBe(settings);
  expect(command.mock.calls.filter(([, args]) => args[0] === "run")).toHaveLength(1);
  expect(command.mock.calls.some(([, args]) => args[0] === "start")).toBe(true);
  expect(startServer).toHaveBeenCalledTimes(2);
});

it("后台已经正常运行时直接复用，不另建数据库", async () => {
  const options = await setup();
  const command = vi.fn();
  const startServer = vi.fn();
  await ensureLocalRuntime({ ...options, dependencies: { command, startServer, probe: async () => true } });
  expect(command).not.toHaveBeenCalled();
  expect(startServer).not.toHaveBeenCalled();
  expect(await readdir(options.dataDir)).toEqual([]);
});

it("缺少预先准备的镜像时明确报错，运行时不联网下载", async () => {
  const options = await setup();
  const command = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "container" || args[0] === "image") throw new Error("未安装");
    return "ok";
  });
  const startServer = vi.fn();
  await expect(ensureLocalRuntime({ ...options, dependencies: { command, startServer, probe: async () => false } }))
    .rejects.toThrow("缺少本机数据库镜像");
  expect(startServer).not.toHaveBeenCalled();
  expect(command.mock.calls.some(([, args]) => args[0] === "pull")).toBe(false);
});

it("应用安装目录被替换后仍能读取旧附件并写入新附件，迁移不覆盖已有数据", async () => {
  const options = await setup();
  options.resourcesDir = join(options.dataDir, "旧安装", "resources");
  const legacyUploads = join(options.resourcesDir, "data", "uploads");
  const persistentUploads = join(options.dataDir, "uploads");
  await mkdir(legacyUploads, { recursive: true });
  await mkdir(persistentUploads, { recursive: true });
  await writeFile(join(legacyUploads, "原图.png"), "旧附件");
  await writeFile(join(legacyUploads, "已有.png"), "旧安装中的副本");
  await writeFile(join(persistentUploads, "已有.png"), "已恢复的附件");

  let ready = false;
  const startServer = vi.fn(async (_file: string, env: NodeJS.ProcessEnv, cwd: string) => {
    expect(env.LOCAL_UPLOAD_DIR).toBe(persistentUploads);
    expect(env.LOCAL_UPLOAD_BASE_URL).toBe(options.apiUrl);
    expect(cwd).toBe(options.dataDir);
    ready = true;
  });
  await ensureLocalRuntime({
    ...options,
    dependencies: { command: async () => "ok", startServer, probe: async () => ready },
  });

  await rm(options.resourcesDir, { recursive: true });
  expect(await readFile(join(persistentUploads, "原图.png"), "utf8")).toBe("旧附件");
  expect(await readFile(join(persistentUploads, "已有.png"), "utf8")).toBe("已恢复的附件");
  await writeFile(join(persistentUploads, "新图.png"), "更新后的附件");
  expect(await readFile(join(persistentUploads, "新图.png"), "utf8")).toBe("更新后的附件");
});
