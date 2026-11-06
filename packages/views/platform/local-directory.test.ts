// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { canOpenLocalDirectory, openLocalDirectory } from "./local-directory";

afterEach(() => { vi.unstubAllGlobals(); });

describe("local directory opening bridge", () => {
  it("is unavailable on web and on desktop builds without the opener", async () => {
    for (const desktopAPI of [undefined, { pickDirectory: vi.fn() }]) {
      vi.stubGlobal("window", { desktopAPI });
      expect(canOpenLocalDirectory()).toBe(false);
      await expect(openLocalDirectory("/projects/demo", "d1")).resolves.toEqual({ ok: false, reason: "unsupported" });
    }
  });

  it("preserves the original path, daemon binding, and native failure result", async () => {
    const result = { ok: false, reason: "not_found" };
    const open = vi.fn().mockResolvedValue(result);
    vi.stubGlobal("window", { desktopAPI: { openLocalDirectory: open } });
    expect(canOpenLocalDirectory()).toBe(true);
    await expect(openLocalDirectory("/projects/中文 client/", "d1")).resolves.toEqual(result);
    expect(open).toHaveBeenCalledWith("/projects/中文 client/", "d1");
  });
});
