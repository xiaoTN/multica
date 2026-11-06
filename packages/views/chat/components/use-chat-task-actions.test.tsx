import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { chatKeys } from "@multica/core/chat/queries";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import enChat from "../../locales/en/chat.json";
import { useChatTaskActions } from "./use-chat-task-actions";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace" }));
vi.mock("@multica/core/api", async original => ({
  ...await original<typeof import("@multica/core/api")>(),
  api: { steerQueuedChatTask: vi.fn(), cancelTask: vi.fn() },
}));
beforeEach(() => vi.clearAllMocks());

describe("queued steering refusals", () => {
  it("explains an ended run when the pending query has already cleared it", async () => {
    const qc = new QueryClient();
    qc.setQueryData(chatKeys.pendingTask("chat"), {});
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { chat: enChat } }}>{children}</I18nProvider></QueryClientProvider>;
    const { result } = renderHook(() => useChatTaskActions("chat", vi.fn()), { wrapper });
    await act(() => result.current.handleSendQueuedTaskNow("queued"));
    expect(toast.error).toHaveBeenCalledWith(enChat.queue.steer_target_changed);
    expect(api.steerQueuedChatTask).not.toHaveBeenCalled();
    expect(api.cancelTask).not.toHaveBeenCalled();
    qc.clear();
  });
  it.each([
    ["chat_steer_unsupported", enChat.queue.steer_unsupported],
    ["chat_steer_target_changed", enChat.queue.steer_target_changed],
    ["chat_steer_message_consumed", enChat.queue.steer_message_consumed],
    ["future_reason", enChat.queue.steer_unavailable_toast],
    [undefined, enChat.queue.steer_unavailable_toast],
  ])("explains %s and preserves the queue without cancelling the run", async (code, message) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pending = { task_id: "run", status: "running", queued_tasks: [{ task_id: "queued", status: "queued", content: "Keep B", created_at: "now" }] };
    qc.setQueryData(chatKeys.pendingTask("chat"), pending);
    const restore = vi.fn();
    vi.mocked(api.steerQueuedChatTask).mockRejectedValue(new ApiError("refused", 409, "Conflict", { code }));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { chat: enChat } }}>{children}</I18nProvider></QueryClientProvider>;
    const { result } = renderHook(() => useChatTaskActions("chat", restore), { wrapper });
    await act(() => result.current.handleSendQueuedTaskNow("queued"));
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(api.steerQueuedChatTask).toHaveBeenCalledWith("chat", "queued", "run");
    expect(api.cancelTask).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(qc.getQueryData(chatKeys.pendingTask("chat"))).toEqual(pending);
    qc.clear();
  });
});
