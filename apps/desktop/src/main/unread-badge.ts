type BadgeAPI = {
  dock?: { setBadge: (text: string) => void };
  setBadgeCount: (count: number) => boolean;
};

/** Each main window contributes its current workspace's server unread count. */
export class UnreadBadge<W> {
  private readonly counts = new Map<W, number>();

  constructor(
    private readonly app: BadgeAPI,
    private readonly platform: NodeJS.Platform,
  ) {}

  set(window: W, rawCount: unknown): void {
    const count =
      typeof rawCount === "number" && Number.isFinite(rawCount)
        ? Math.max(0, Math.floor(rawCount))
        : 0;
    this.counts.set(window, count);
    this.apply();
  }

  remove(window: W): void {
    if (this.counts.delete(window)) this.apply();
  }

  clear(): void {
    this.counts.clear();
    this.apply();
  }

  private apply(): void {
    let count = 0;
    for (const value of this.counts.values()) count += value;
    if (this.platform === "darwin") {
      this.app.dock?.setBadge(count === 0 ? "" : count > 99 ? "99+" : String(count));
    } else {
      this.app.setBadgeCount(count);
    }
  }
}
