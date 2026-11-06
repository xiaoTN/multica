// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentTaskSchema, ChatPendingTaskSchema } from "./schemas";

describe("run wait diagnostics", () => {
  const diagnostic = { code: "agent_concurrency", phase: "queued", scope: "agent", occupied: 6, limit: 6, evaluated_at: "2026-11-05T12:00:00Z", since: "2026-11-05T11:59:00Z" };
  it("preserves the same evidence on run and chat responses", () => {
    expect(AgentTaskSchema.parse({ id: "run", wait_diagnostic: diagnostic }).wait_diagnostic).toEqual(diagnostic);
    expect(ChatPendingTaskSchema.parse({ task_id: "run", wait_diagnostic: diagnostic }).wait_diagnostic).toEqual(diagnostic);
  });
  it("degrades malformed optional evidence without losing the run", () => {
    expect(AgentTaskSchema.parse({ id: "run", wait_diagnostic: { ...diagnostic, occupied: -1 } })).toMatchObject({ id: "run", wait_diagnostic: undefined });
    expect(ChatPendingTaskSchema.parse({ task_id: "run", wait_diagnostic: null }).wait_diagnostic).toBeUndefined();
  });
  it("keeps unknown future codes for a generic presentation", () => {
    expect(AgentTaskSchema.parse({ id: "run", wait_diagnostic: { ...diagnostic, code: "future_wait" } }).wait_diagnostic?.code).toBe("future_wait");
  });
  it("retains cleared history and ignores a malformed optional history", () => {
    const history = [{ at: diagnostic.evaluated_at, status: "running", diagnostic: null }];
    expect(AgentTaskSchema.parse({ id: "run", wait_history: history }).wait_history).toEqual(history);
    expect(AgentTaskSchema.parse({ id: "run", wait_history: [{ ...history[0], at: "invalid" }] })).toMatchObject({ id: "run", wait_history: undefined });
  });
});
