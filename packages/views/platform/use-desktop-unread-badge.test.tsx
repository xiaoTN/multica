import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { createQueryClient } from "@multica/core/query-client";
import { onInboxSummaryInvalidate } from "@multica/core/inbox/ws-updaters";
import type { InboxWorkspaceUnread } from "@multica/core/types";
import { useDesktopUnreadBadge } from "./use-desktop-unread-badge";

let summary: InboxWorkspaceUnread[];
const getInboxUnreadSummary = vi.fn(async () => summary);
const setUnreadBadge = vi.fn();

beforeEach(() => {
  summary = [{ workspace_id: "work", count: 3 }, { workspace_id: "personal", count: 7 }];
  getInboxUnreadSummary.mockClear();
  setUnreadBadge.mockClear();
  setApiInstance({ getInboxUnreadSummary } as unknown as ApiClient);
  vi.stubGlobal("desktopAPI", { setUnreadBadge });
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

function setup(wsId: string | null = "work") {
  const qc = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = renderHook(({ wsId }) => useDesktopUnreadBadge(wsId), {
    initialProps: { wsId }, wrapper,
  });
  return { qc, ...view };
}

describe("useDesktopUnreadBadge", () => {
  it("keeps new, read and all-read counts live while minimized without opening the inbox", async () => {
    focusManager.setFocused(false);
    const { qc } = setup();
    await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(3));

    for (const count of [4, 2, 0]) {
      summary = [{ workspace_id: "work", count }];
      await act(async () => { await onInboxSummaryInvalidate(qc); });
      await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(count));
    }
    // No inbox list or mark-read API is installed: observing the badge only reads.
    expect(getInboxUnreadSummary).toHaveBeenCalledTimes(4);
  });

  it("uses only the current workspace's grouped unread count", async () => {
    const { rerender } = setup();
    await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(3));
    rerender({ wsId: "personal" });
    await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(7));
    rerender({ wsId: "empty" });
    await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(0));
    rerender({ wsId: null });
    expect(setUnreadBadge).toHaveBeenLastCalledWith(0);
  });

  it("clears on shell unmount and restores the count when reopened", async () => {
    const { unmount } = setup();
    await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(3));
    unmount();
    expect(setUnreadBadge).toHaveBeenLastCalledWith(0);

    summary = [{ workspace_id: "work", count: 5 }];
    setup();
    await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(5));
  });

  it("does not fetch with no workspace and remains safe on web", () => {
    vi.stubGlobal("desktopAPI", undefined);
    const { unmount } = setup(null);
    expect(getInboxUnreadSummary).not.toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
  });
});
