// @vitest-environment node
import type { Session } from "electron";
import { expect, it, vi } from "vitest";
import { installLocalNetworkPolicy } from "./local-network-policy";

it("在创建窗口前拦截外部请求，重定向后的外部地址也不能通过", async () => {
  const onBeforeRequest = vi.fn();
  const setProxy = vi.fn().mockResolvedValue(undefined);
  const session = { setProxy, webRequest: { onBeforeRequest } };
  await installLocalNetworkPolicy(session as unknown as Session);
  expect(setProxy).toHaveBeenCalledWith({ mode: "direct" });
  const handler = onBeforeRequest.mock.calls[0][0];
  const callback = vi.fn();
  handler({ url: "http://127.0.0.1:8080/api/me" }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: false });
  handler({ url: "https://example.com/redirect" }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  handler({ url: "wss://api.multica.ai/ws" }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
});
