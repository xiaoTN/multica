import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import { useCommentComposerStore } from "@multica/core/issues/stores/comment-composer-store";
import { useChatSend } from "./use-chat-send";
import enChat from "../../locales/en/chat.json";

const queries = vi.hoisted(() => ({ fetchQuery: vi.fn() }));
vi.mock("@tanstack/react-query", async (original) => ({ ...(await original<typeof import("@tanstack/react-query")>()), useQueryClient: () => queries }));
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../i18n", () => ({ useT: () => ({ t: (select: (chat: typeof enChat) => string) => select(enChat) }) }));
vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: { sendChatMessage: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  queries.fetchQuery.mockResolvedValue(null);
  useCommentComposerStore.setState({ runningAgentReply: "steer" });
  vi.mocked(api.sendChatMessage).mockResolvedValue({ message_id: "message", task_id: "run", created_at: "now", steered: true });
});

describe("chat send routing", () => {
  it.each([
    ["chat_steer_unsupported", enChat.input.steer_unsupported],
    ["chat_steer_target_changed", enChat.input.steer_target_changed],
    ["future_reason", enChat.input.steer_unavailable],
  ])("explains direct steering refusal %s without accepting the draft", async (code, copy) => {
    vi.mocked(api.sendChatMessage).mockRejectedValue(new ApiError("refused", 409, "Conflict", { code }));
    const { result } = renderHook(() => useChatSend("chat"));
    expect(await result.current.sendMessage("chat", "retain draft", undefined, "run")).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(copy);
    expect(api.sendChatMessage).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["steer", "after_run", "queue"],
    ["after_run", "steer", "steer"],
  ] as const)("uses the shortcut mode over the %s preference", async (preferred, shortcutMode, expectedMode) => {
    useCommentComposerStore.setState({ runningAgentReply: preferred });
    const { result } = renderHook(() => useChatSend("chat"));
    await result.current.sendMessage("chat", "shortcut", undefined, "exact-run", shortcutMode);
    expect(api.sendChatMessage).toHaveBeenCalledWith("chat", "shortcut", undefined, { mode: expectedMode, expectedTaskId: "exact-run" });
    expect(result.current.sendMode).toBe(preferred);
  });
  it("finds the running turn before sending while the initial cache is empty", async () => {
    queries.fetchQuery.mockResolvedValue({ task_id: "server-running-turn", status: "running", supports_queue: true });
    const { result } = renderHook(() => useChatSend("chat"));
    await result.current.sendMessage("chat", "early Enter", undefined, null);
    expect(api.sendChatMessage).toHaveBeenCalledWith("chat", "early Enter", undefined, { mode: "steer", expectedTaskId: "server-running-turn" });
  });
  it("reads the preference when reopened and sends normally without a run", async () => {
    const first = renderHook(() => useChatSend("chat"));
    act(() => useCommentComposerStore.getState().setRunningAgentReply("after_run"));
    expect(first.result.current.sendMode).toBe("after_run");
    first.unmount();
    const reopened = renderHook(() => useChatSend("chat"));
    expect(reopened.result.current.sendMode).toBe("after_run");
    await reopened.result.current.sendMessage("chat", "hello", undefined, null);
    expect(api.sendChatMessage).toHaveBeenCalledWith("chat", "hello", undefined);
  });

  it("honors explicit queue and resets a message override on session change", async () => {
    const { result, rerender } = renderHook(({ id }) => useChatSend(id), { initialProps: { id: "chat" } });
    act(() => result.current.setSendMode("after_run"));
    await result.current.sendMessage("chat", "later", undefined, "exact-run");
    expect(api.sendChatMessage).toHaveBeenCalledWith("chat", "later", undefined, { mode: "queue", expectedTaskId: "exact-run" });
    rerender({ id: "other-chat" });
    expect(result.current.sendMode).toBe("steer");
  });

  it("keeps a refused steer unaccepted so the composer retains its draft", async () => {
    vi.mocked(api.sendChatMessage).mockRejectedValue(new ApiError("run ended", 409, "Conflict"));
    const { result } = renderHook(() => useChatSend("chat"));
    expect(await result.current.sendMessage("chat", "retain this", undefined, "ended-run")).toBeNull();
    expect(api.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("reports the actual queue outcome from older servers", async () => {
    vi.mocked(api.sendChatMessage).mockResolvedValue({ message_id: "message", task_id: "new-run", created_at: "now", queued: true });
    const { result } = renderHook(() => useChatSend("chat"));
    const response = await result.current.sendMessage("chat", "hello", undefined, "old-run");
    expect(response?.task_id).toBe("new-run");
    expect(toast.info).toHaveBeenCalledOnce();
  });
});
