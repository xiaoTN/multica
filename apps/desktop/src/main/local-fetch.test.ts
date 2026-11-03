// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { fetchLocal } from "./local-fetch";

it("主进程可以访问本机服务，但不会跟随服务返回的跳转", async () => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/target" });
    } else { redirectedRequests += 1; }
    response.end("local");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    expect(await (await fetchLocal(url)).text()).toBe("local");
    await expect(fetchLocal(`${url}/redirect`)).rejects.toThrow();
    expect(redirectedRequests).toBe(1);
    expect(() => fetchLocal("https://api.multica.ai")).toThrow(/只能使用本机地址/);
  } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
});
