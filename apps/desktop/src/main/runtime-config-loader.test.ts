// @vitest-environment node
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }));
import { DEFAULT_RUNTIME_CONFIG } from "../shared/runtime-config";
import { loadRuntimeConfig } from "./runtime-config-loader";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("配置缺失时只使用本机默认值，外部配置和损坏配置均阻止启动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "multica-local-config-"));
  dirs.push(dir);
  const configPath = join(dir, "desktop.json");
  await expect(loadRuntimeConfig({ isDev: false, configPath, env: {} })).resolves.toEqual({ ok: true, config: DEFAULT_RUNTIME_CONFIG });
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, apiUrl: "https://api.multica.ai" }));
  await expect(loadRuntimeConfig({ isDev: false, configPath, env: {} })).resolves.toMatchObject({ ok: false });
  await writeFile(configPath, "{");
  await expect(loadRuntimeConfig({ isDev: false, configPath, env: {} })).resolves.toMatchObject({ ok: false });
  await expect(loadRuntimeConfig({ isDev: true, configPath, env: {} })).resolves.toEqual({ ok: true, config: DEFAULT_RUNTIME_CONFIG });
});
