// @vitest-environment node
import { expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, () => unknown>());
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: () => unknown) => handlers.set(name, handler) } }));
import { setupLocalUpdater } from "./local-updater";

it("检查、下载和安装更新均不可用，设置也无法重新开启自动更新", () => {
  setupLocalUpdater();
  for (const channel of ["updater:check", "updater:download", "updater:install"]) {
    expect(handlers.get(channel)?.()).toMatchObject({ ok: false });
  }
  expect(handlers.get("updater:get-preferences")?.()).toEqual({ automaticUpdates: false });
  expect(handlers.get("updater:set-automatic-updates")?.()).toEqual({ automaticUpdates: false });
});
