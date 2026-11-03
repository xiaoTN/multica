// 只接受明确的本机地址，不解析任意域名，也不把局域网地址当成本机。
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    return url.hostname === "localhost" || url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  } catch {
    return false;
  }
}

export function isLocalResourceUrl(value: string): boolean {
  if (isLoopbackUrl(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return !url.hostname || url.hostname === "localhost";
    return ["data:", "blob:", "about:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function requireLoopbackUrl(value: string, field: string): void {
  if (!isLoopbackUrl(value)) throw new Error(`${field} 只能使用本机地址（127.0.0.1、localhost 或 ::1）`);
}
