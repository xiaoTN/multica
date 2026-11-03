#!/usr/bin/env node
// Builds the `multica` CLI from server/cmd/multica and copies the binary
// into apps/desktop/resources/bin/ so electron-vite (dev) and electron-
// builder (prod) pick it up. Running this on every dev/build/package
// invocation guarantees the bundled CLI always matches the current Go
// source — no more stale binary surprises. Go's build cache makes the
// no-op case (nothing changed) effectively free.
//
// ldflags mirror `make build` so `multica --version` reports a meaningful
// version / commit / date.
//
// 本机版本必须使用当前源码构建的 CLI，缺少 Go 时立即失败，不下载其他版本。

import { access, chmod, copyFile, mkdir, rm } from "node:fs/promises";
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

function binaryNameForPlatform(platform) {
  return platform === "win32" ? "multica.exe" : "multica";
}

const targetPlatform = normalizeRuntimePlatform(
  runtimePlatformFromArgs(process.argv.slice(2)),
);
const targetArch = normalizeRuntimeArch(runtimeArchFromArgs(process.argv.slice(2)));
const goos = PLATFORM_TO_GOOS[targetPlatform];
const goarch = targetArch === "x64" ? "amd64" : targetArch;
const binName = binaryNameForPlatform(targetPlatform);
const srcBinary = join(serverDir, "bin", `${goos}-${goarch}`, binName);
const destDir = join(repoRoot, "apps", "desktop", "resources", "bin");
const destBinary = join(destDir, binName);

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

if (hasGo()) {
  const version = deriveVersion() || "dev";
  const commit = git("rev-parse", "--short", "HEAD") || "unknown";
  const buildCommit = git("rev-parse", "HEAD") || "unknown";
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const ldflags = `-X main.version=${version} -X main.commit=${commit} -X main.buildCommit=${buildCommit} -X main.date=${date}`;

  console.log(
    `[bundle-cli] go build → ${srcBinary} (${goos}/${goarch}, version=${version} commit=${commit})`,
  );
  await mkdir(join(serverDir, "bin", `${goos}-${goarch}`), { recursive: true });
  execFileSync(
    "go",
    [
      "build",
      "-ldflags",
      ldflags,
      "-o",
      srcBinary,
      "./cmd/multica",
    ],
    {
      cwd: serverDir,
      stdio: "inherit",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: goos,
        GOARCH: goarch,
      },
    },
  );
} else {
  throw new Error("本机版本必须使用 Go 构建配套 CLI，请先准备 Go 工具。");
}

if (!(await exists(srcBinary))) {
  throw new Error(`配套 CLI 未生成，已停止打包：${srcBinary}`);
}

await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });
await copyFile(srcBinary, destBinary);
await chmod(destBinary, 0o755);

// macOS: ad-hoc sign so Gatekeeper doesn't complain when the parent app
// (which itself may be unsigned in dev) spawns the child.
if (process.platform === "darwin") {
  try {
    execSync(`codesign -s - --force ${JSON.stringify(destBinary)}`, {
      stdio: "pipe",
    });
  } catch {
    // Non-fatal. Unsigned binaries still run when the parent app is trusted.
  }
}

console.log(`[bundle-cli] bundled ${srcBinary} → ${destBinary}`);
