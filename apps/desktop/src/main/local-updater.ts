import { ipcMain } from "electron";

// 保留设置页面使用的通道，但本地版本不加载更新器、不检查或下载新版本。
export function setupLocalUpdater(): void {
  const disabled = () => ({ ok: false, error: "本机版本已移除联网更新，请手动构建新版本。" });
  ipcMain.handle("updater:check", disabled);
  ipcMain.handle("updater:download", disabled);
  ipcMain.handle("updater:install", disabled);
  ipcMain.handle("updater:get-preferences", () => ({ automaticUpdates: false }));
  ipcMain.handle("updater:set-automatic-updates", () => ({ automaticUpdates: false }));
}
