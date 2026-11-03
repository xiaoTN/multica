// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isLocalResourceUrl, isLoopbackUrl } from "./local-network";

describe("本机网络范围", () => {
  it.each(["http://127.0.0.1:8080", "ws://localhost:8080/ws", "http://[::1]:3000", "https://127.0.0.2"])("允许本机服务 %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });
  it.each(["https://api.multica.ai", "http://192.168.1.1", "http://127.0.0.1.example.com", "http://localhost.example.com", "http://user:pass@localhost", "not a url"])("拒绝外部或无效地址 %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
    expect(isLocalResourceUrl(url)).toBe(false);
  });
  it.each(["file:///app/index.html", "data:text/plain,hello", "blob:file:///id", "about:blank"])("允许界面资源 %s", (url) => {
    expect(isLocalResourceUrl(url)).toBe(true);
  });
  it("拒绝带远程主机的文件地址", () => {
    expect(isLocalResourceUrl("file://server/share/a")).toBe(false);
  });
});
