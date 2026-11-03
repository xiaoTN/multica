// @vitest-environment node
import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
import { shell } from "electron";
import { openExternalSafely, isSafeExternalHttpUrl } from "./external-url";

it("浏览器只打开本机服务，外部链接和其他协议均不交给系统", () => {
  for (const url of ["https://multica.ai", "https://user:pass@example.com", "file:///etc/passwd", "javascript:alert(1)", "invalid"]) {
    expect(isSafeExternalHttpUrl(url)).toBe(false);
    openExternalSafely(url);
  }
  expect(shell.openExternal).not.toHaveBeenCalled();
  openExternalSafely("http://127.0.0.1:3000/login");
  expect(shell.openExternal).toHaveBeenCalledWith("http://127.0.0.1:3000/login");
});
