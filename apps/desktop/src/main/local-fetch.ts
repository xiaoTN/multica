import { requireLoopbackUrl } from "../shared/local-network";

// 主进程的 Node 请求不经过浏览器会话的拦截器，需要单独检查地址和跳转。
export function fetchLocal(url: string, options: RequestInit = {}): Promise<Response> {
  requireLoopbackUrl(url, "后台请求");
  return fetch(url, { ...options, redirect: "error" });
}
