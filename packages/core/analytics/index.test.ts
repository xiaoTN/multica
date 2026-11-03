import { expect, it, vi } from "vitest";
import { captureEvent, captureException, captureSignupSource, identify, initAnalytics, resetAnalytics, setPersonProperties } from "./index";

it("即使服务端提供统计配置，本机版本也不收集和发送数据", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const onCaptured = vi.fn();
  expect(initAnalytics({ key: "key", host: "https://example.com" })).toBe(false);
  identify("local-user");
  captureEvent("test", { private: "value" }, { onCaptured });
  captureException(new Error("local"));
  captureSignupSource();
  setPersonProperties({ name: "local" });
  resetAnalytics();
  expect(fetch).not.toHaveBeenCalled();
  expect(onCaptured).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
