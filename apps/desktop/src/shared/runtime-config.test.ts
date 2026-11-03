// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig, runtimeConfigFromDevEnv } from "./runtime-config";

describe("本机运行配置", () => {
  it("开发和打包默认值均只指向本机", () => {
    expect(runtimeConfigFromDevEnv({})).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(parseRuntimeConfig(JSON.stringify({ schemaVersion: 1, apiUrl: "http://localhost:8080" }))).toEqual(DEFAULT_RUNTIME_CONFIG);
  });
  it("允许为本机服务指定其他端口", () => {
    expect(runtimeConfigFromDevEnv({ apiUrl: "http://localhost:8088/", appUrl: "http://localhost:3008/" })).toEqual({
      schemaVersion: 1, apiUrl: "http://127.0.0.1:8088", wsUrl: "ws://127.0.0.1:8088/ws", appUrl: "http://127.0.0.1:3008",
    });
  });
  it.each(["apiUrl", "wsUrl", "appUrl"])("拒绝配置中的外部地址 %s", (field) => {
    expect(() => parseRuntimeConfig(JSON.stringify({ ...DEFAULT_RUNTIME_CONFIG, [field]: field === "wsUrl" ? "wss://api.multica.ai/ws" : "https://multica.ai" }))).toThrow(/只能使用本机地址/);
  });
  it("开发环境变量也不能切回云端", () => {
    expect(() => runtimeConfigFromDevEnv({ apiUrl: "https://api.multica.ai" })).toThrow(/只能使用本机地址/);
  });
  it.each(["{", "null", "[]", '{"schemaVersion":2}', '{"schemaVersion":1,"apiUrl":"file:///tmp/x"}'])("拒绝无效配置 %s", (raw) => {
    expect(() => parseRuntimeConfig(raw)).toThrow();
  });
});
