import type { Session } from "electron";
import { isLocalResourceUrl } from "../shared/local-network";

export async function installLocalNetworkPolicy(session: Session): Promise<void> {
  // 本机请求直接连接，避免经过环境里配置的外部代理。
  await session.setProxy({ mode: "direct" });
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isLocalResourceUrl(details.url) });
  });
}
