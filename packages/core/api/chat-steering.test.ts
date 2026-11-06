// @vitest-environment node
import { describe, expect, it, vi, afterEach } from "vitest";
import { ApiClient, ApiError, chatSteerErrorCode } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("chat steering compatibility", () => {
  it.each(["chat_steer_unsupported", "chat_steer_target_changed", "chat_steer_message_consumed", "future_reason"])("preserves the structured rejection %s", async code => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, error: "refused" }), { status: 409 })));
    const err = await new ApiClient("https://example.test").steerQueuedChatTask("chat", "queued", "run").catch((err: unknown) => err);
    expect(chatSteerErrorCode(err)).toBe(code);
  });
  it.each([undefined, null, [], "invalid", { code: 1 }, { code: null }, {}])("ignores malformed or legacy error bodies %j", body => {
    expect(chatSteerErrorCode(new ApiError("refused", 409, "Conflict", body))).toBeUndefined();
  });
  it("does not mistake other errors for a steering refusal", () => {
    expect(chatSteerErrorCode(new ApiError("failed", 500, "Error", { code: "chat_steer_unsupported" }))).toBeUndefined();
  });
  it.each([false, true, undefined, null, "false"])("validates an optional negotiated capability %j", async canSteer => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ task_id: "run", status: "running", can_steer: canSteer }))));
    const pending = await new ApiClient("https://example.test").getPendingChatTask("chat");
    expect(pending.task_id).toBe("run");
    expect(pending.can_steer).toBe(typeof canSteer === "boolean" ? canSteer : undefined);
  });
});
