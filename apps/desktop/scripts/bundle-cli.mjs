#!/usr/bin/env node
// 每次构建都从当前 Go 源码生成命令行、后台和数据库初始化程序。
// 版本信息与 make build 一致，不下载其他版本，也不要求用户在运行时安装 Go。

import { access, chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveVersion } from "./package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const serverDir = join(repoRoot, "server");

const PLATFORM_TO_GOOS = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const SUPPORTED_ARCHS = new Set(["x64", "arm64"]);

function runtimePlatformFromArgs(argv) {
  const flagIndex = argv.indexOf("--target-platform");
  if (flagIndex === -1) return process.platform;
  return argv[flagIndex + 1] ?? "";
}

function runtimeArchFromArgs(argv) {
  const flagIndex = argv.indexOf("--target-arch");
  if (flagIndex === -1) return process.arch;
  return argv[flagIndex + 1] ?? "";
}

function normalizeRuntimePlatform(platform) {
  if (platform in PLATFORM_TO_GOOS) return platform;
  throw new Error(
    `[bundle-cli] unsupported target platform: ${platform}. ` +
      "Use darwin, linux, or win32.",
  );
}

function normalizeRuntimeArch(arch) {
  if (SUPPORTED_ARCHS.has(arch)) return arch;
  throw new Error(
    `[bundle-cli] unsupported target architecture: ${arch}. ` +
      "Use x64 or arm64.",
  );
}

const targetPlatform = normalizeRuntimePlatform(
  runtimePlatformFromArgs(process.argv.slice(2)),
);
const targetArch = normalizeRuntimeArch(runtimeArchFromArgs(process.argv.slice(2)));
const goos = PLATFORM_TO_GOOS[targetPlatform];
const goarch = targetArch === "x64" ? "amd64" : targetArch;
const destDir = join(repoRoot, "apps", "desktop", "resources", "bin");

// Hand git arguments straight to the binary (no shell) on every platform.
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd: repoRoot }).trim();
  } catch {
    return "";
  }
}

function hasGo() {
  try {
    execSync("go version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (!hasGo()) {
  throw new Error("本机版本需要 Go 来构建配套程序，请先准备 Go 工具。");
}

const version = deriveVersion() || "dev";
const commit = git("rev-parse", "--short", "HEAD") || "unknown";
const buildCommit = git("rev-parse", "HEAD") || "unknown";
const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const ldflags = `-X main.version=${version} -X main.commit=${commit} -X main.buildCommit=${buildCommit} -X main.date=${date}`;
await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });

// 桌面应用同时携带命令行、后台和数据库迁移程序，启动时无需源码或 Go。
for (const target of [
  { package: "multica", name: "multica" },
  { package: "server", name: "agent-team-server" },
  { package: "migrate", name: "agent-team-migrate" },
]) {
  const name = target.name + (targetPlatform === "win32" ? ".exe" : "");
  const source = join(serverDir, "bin", `${goos}-${goarch}`, name);
  const destination = join(destDir, name);
  await mkdir(join(serverDir, "bin", `${goos}-${goarch}`), { recursive: true });
  console.log(`[构建本机程序] ${target.name}，平台 ${goos}/${goarch}`);
  execFileSync("go", ["build", "-ldflags", ldflags, "-o", source, `./cmd/${target.package}`], {
    cwd: serverDir,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  });
  if (!(await exists(source))) throw new Error(`配套程序未生成：${target.name}`);
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  if (process.platform === "darwin") {
    execFileSync("codesign", ["-s", "-", "--force", destination], { stdio: "pipe" });
  }
}
const migrationsDir = join(destDir, "..", "migrations");
await rm(migrationsDir, { recursive: true, force: true });
await cp(join(serverDir, "migrations"), migrationsDir, { recursive: true });
console.log("[构建本机程序] 后台、数据库迁移和命令行均已打包");
