// 本机版本不收集或上报统计、身份、异常和来源信息，也不加载统计 SDK。
export const EVENT_SCHEMA_VERSION = 2;
export interface AnalyticsConfig {
  key: string;
  host: string;
  appVersion?: string;
  environment?: string;
}
export type ClientType = "desktop" | "web";
export interface CaptureEventOptions {
  sendInstantly?: boolean;
  onCaptured?: () => void;
}
export function detectClientType(): ClientType {
  if (typeof window === "undefined") return "web";
  return "desktopAPI" in window || "electron" in window ? "desktop" : "web";
}
export function initAnalytics(_config: AnalyticsConfig | null | undefined): boolean { return false; }
export function identify(_userId: string, _properties?: Record<string, unknown>): void { return; }
export function resetAnalytics(): void { return; }
export function captureEvent(_name: string, _properties?: Record<string, unknown>, _options?: CaptureEventOptions): void { return; }
export function captureException(_error: unknown, _properties?: Record<string, unknown>): void { return; }
export function setPersonProperties(_properties: Record<string, unknown>): void { return; }
export function captureSignupSource(): void { return; }
