// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { UnreadBadge } from "./unread-badge";

function setup(platform: NodeJS.Platform = "darwin") {
  const app = { dock: { setBadge: vi.fn() }, setBadgeCount: vi.fn(() => true) };
  return { app, badge: new UnreadBadge<string>(app, platform) };
}

describe("UnreadBadge", () => {
  it("updates the native Dock number and removes the badge at zero", () => {
    const { app, badge } = setup();
    for (const count of [2, 3, 1, 0]) badge.set("main", count);
    expect(app.dock.setBadge.mock.calls).toEqual([["2"], ["3"], ["1"], [""]]);
    expect(app.setBadgeCount).not.toHaveBeenCalled();
  });

  it("sums main windows, replaces a switched workspace's count and removes closed windows", () => {
    const { app, badge } = setup();
    badge.set("work", 4);
    badge.set("personal", 3);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("7");
    badge.set("work", 2);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("5");
    badge.remove("personal");
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("2");
    badge.remove("work");
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("");
    badge.set("reopened", 6);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("6");
  });

  it("clears every window on account transitions before accepting the new count", () => {
    const { app, badge } = setup();
    badge.set("main", 5);
    badge.set("other", 3);
    badge.clear();
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("");
    badge.set("main", 1);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("1");
  });

  it("caps large Dock counts at 99+", () => {
    const { app, badge } = setup();
    badge.set("main", 99);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("99");
    badge.set("main", 100);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith("99+");
  });

  it.each([NaN, Infinity, -Infinity, -2, "3", null, undefined])(
    "clears malformed or negative counts (%s)", (count) => {
      const { app, badge } = setup();
      badge.set("main", 4);
      badge.set("main", count);
      expect(app.dock.setBadge).toHaveBeenLastCalledWith("");
    },
  );

  it("normalizes fractional counts before using the non-macOS badge API", () => {
    const { app, badge } = setup("linux");
    badge.set("main", 3.9);
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(3);
    badge.clear();
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(app.dock.setBadge).not.toHaveBeenCalled();
  });
});
