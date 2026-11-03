import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fetchLocal } from "./local-fetch";

const execFileAsync = promisify(execFile);
const CONTAINER = "agent-team-local-postgres";
const VOLUME = "agent-team-local-data";
const DATABASE_PORT = 54329;
const DATABASE_IMAGE = "postgres:16-alpine";

interface RuntimeSettings {
  password: string;
  jwtSecret: string;
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeout?: number;
}

interface RuntimeDependencies {
  command: (file: string, args: string[], options?: CommandOptions) => Promise<string>;
  probe: () => Promise<boolean>;
  startServer: (file: string, env: NodeJS.ProcessEnv, cwd: string, logPath: string) => Promise<void>;
}

async function command(file: string, args: string[], options: CommandOptions = {}): Promise<string> {
  try {
    const result = await execFileAsync(file, args, { timeout: 30_000, ...options });
    return result.stdout.trim();
  } catch (error) {
    if (error && typeof error === "object" && "signal" in error && error.signal === "SIGKILL") {
      throw new Error(`${basename(file)} 被系统终止（SIGKILL）。请确认该程序已获系统或公司软件策略允许运行。`);
    }
    throw error;
  }
}

async function startServer(file: string, env: NodeJS.ProcessEnv, cwd: string, logPath: string): Promise<void> {
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(file, [], { cwd, env, detached: true, stdio: ["ignore", log.fd, log.fd] });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // 后台进程独立于窗口，关闭应用后仍能完成正在执行的任务。
    child.unref();
  } finally {
    await log.close();
  }
}

async function waitUntil(check: () => Promise<boolean>, label: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(`${label}未能及时启动`);
}

async function loadSettings(dataDir: string): Promise<RuntimeSettings> {
  const path = join(dataDir, "runtime.json");
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value && typeof value === "object" && "password" in value && "jwtSecret" in value &&
        typeof value.password === "string" && value.password.length >= 32 &&
        typeof value.jwtSecret === "string" && value.jwtSecret.length >= 32) {
      return { password: value.password, jwtSecret: value.jwtSecret };
    }
    throw new Error("本机服务配置损坏，请保留数据并检查 runtime.json");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    const settings = { password: randomBytes(32).toString("hex"), jwtSecret: randomBytes(32).toString("hex") };
    await writeFile(path, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
    return settings;
  }
}

export async function ensureLocalRuntime(options: {
  apiUrl: string;
  appUrl: string;
  dataDir: string;
  resourcesDir: string;
  dependencies?: Partial<RuntimeDependencies>;
}): Promise<void> {
  const { apiUrl, appUrl, dataDir, resourcesDir } = options;
  const deps: RuntimeDependencies = {
    command,
    startServer,
    probe: async () => {
      try {
        const response = await fetchLocal(`${apiUrl}/auth/local`, { method: "POST", signal: AbortSignal.timeout(1500) });
        if (!response.ok) return false;
        const value: unknown = await response.json();
        return !!value && typeof value === "object" && "token" in value && typeof value.token === "string" && value.token.length > 0;
      } catch { return false; }
    },
    ...options.dependencies,
  };
  if (await deps.probe()) return;

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const settings = await loadSettings(dataDir);
  const docker = ["/opt/homebrew/bin/docker", "/usr/local/bin/docker"].find(existsSync) ?? "docker";
  try {
    await deps.command(docker, ["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    const colima = "/opt/homebrew/bin/colima";
    if (process.platform !== "darwin" || !existsSync(colima)) {
      throw new Error("本机数据库需要 Docker，请先启动 Docker 后重新打开应用。");
    }
    await deps.command(colima, ["start"], { timeout: 120_000 });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POSTGRES_USER: "agentteam", POSTGRES_DB: "agentteam", POSTGRES_PASSWORD: settings.password,
    DATABASE_URL: `postgres://agentteam:${settings.password}@127.0.0.1:${DATABASE_PORT}/agentteam?sslmode=disable`,
    DATABASE_REPLICA_URL: "", REDIS_URL: "", JWT_SECRET: settings.jwtSecret,
    APP_ENV: "production", PORT: new URL(apiUrl).port || "8080",
    MULTICA_PUBLIC_URL: apiUrl, MULTICA_APP_URL: appUrl, FRONTEND_ORIGIN: appUrl,
    MULTICA_DEV_VERIFICATION_CODE: "", ALLOW_SIGNUP: "false",
  };
  let exists = false;
  try {
    await deps.command(docker, ["container", "inspect", CONTAINER]);
    exists = true;
  } catch { /* 容器不存在时才创建，已有数据库始终保留。 */ }
  if (exists) {
    await deps.command(docker, ["start", CONTAINER]);
  } else {
    try { await deps.command(docker, ["image", "inspect", DATABASE_IMAGE]); }
    catch { throw new Error("缺少本机数据库镜像，请先完成安装准备：docker pull postgres:16-alpine"); }
    await deps.command(docker, [
      "run", "-d", "--pull=never", "--name", CONTAINER, "--restart", "unless-stopped",
      "-p", `127.0.0.1:${DATABASE_PORT}:5432`, "-v", `${VOLUME}:/var/lib/postgresql/data`,
      "-e", "POSTGRES_USER", "-e", "POSTGRES_DB", "-e", "POSTGRES_PASSWORD", DATABASE_IMAGE,
    ], { env });
  }
  await waitUntil(async () => {
    try {
      await deps.command(docker, ["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "agentteam", "-d", "agentteam"]);
      return true;
    } catch { return false; }
  }, "本机数据库", 60_000);

  const suffix = process.platform === "win32" ? ".exe" : "";
  const migrate = join(resourcesDir, "bin", `agent-team-migrate${suffix}`);
  const server = join(resourcesDir, "bin", `agent-team-server${suffix}`);
  await deps.command(migrate, ["up"], { env, cwd: resourcesDir, timeout: 120_000 });
  await deps.startServer(server, env, resourcesDir, join(dataDir, "server.log"));
  await waitUntil(deps.probe, "本机后台", 45_000);
}
