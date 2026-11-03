#!/usr/bin/env node
// macOS 的菜单栏和切换器读取 Electron 的 plist，需要在启动前改开发版名称。
// 每次启动时检查，名称一致就跳过；写入前解除硬链接，避免修改共享的依赖缓存。
// worktree 后缀与主进程使用同一个环境变量，方便区分不同开发实例。

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "darwin") process.exit(0);

const DESIRED_NAME = process.env.DESKTOP_APP_SUFFIX
  ? `Agent团队协作 开发版 ${process.env.DESKTOP_APP_SUFFIX}`
  : "Agent团队协作 开发版";

const require = createRequire(import.meta.url);
// `require('electron')` returns the path to the executable
// (.../Electron.app/Contents/MacOS/Electron). Walk up to Contents/Info.plist.
const electronBin = require("electron");
const plistPath = resolve(electronBin, "../../Info.plist");

function plistGet(key) {
  try {
    return execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, plistPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

function plistSet(key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :${key} ${value}`,
      plistPath,
    ]);
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Add :${key} string ${value}`,
      plistPath,
    ]);
  }
}

if (
  plistGet("CFBundleName") === DESIRED_NAME &&
  plistGet("CFBundleDisplayName") === DESIRED_NAME
) {
  process.exit(0);
}

// Break any pnpm hardlink to the global store: read, unlink, rewrite.
// PlistBuddy would otherwise write through the hardlink and mutate the
// shared store file (and every other project's Electron.app with it).
const original = readFileSync(plistPath);
unlinkSync(plistPath);
writeFileSync(plistPath, original);

plistSet("CFBundleName", DESIRED_NAME);
plistSet("CFBundleDisplayName", DESIRED_NAME);

console.log(`[brand-dev-electron] ${plistPath} → CFBundleName="${DESIRED_NAME}"`);
