import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderWithI18n } from "../test/i18n";
import { RunWaitDetails, useRunWaitLabel } from "./run-wait";
import type { RunWaitDiagnostic } from "@multica/core/types";

afterEach(cleanup);
function Label({ diagnostic, status = "queued" }: { diagnostic?: RunWaitDiagnostic; status?: string }) {
  const label = useRunWaitLabel(diagnostic, status);
  return <>{label && <><p>{label}</p><RunWaitDetails diagnostic={diagnostic} /></>}</>;
}
it("shows reported Chinese capacity with keyboard-accessible details and hides it after execution starts", () => {
  const diagnostic = { code: "agent_concurrency", phase: "queued", scope: "agent", occupied: 6, limit: 6, evaluated_at: "2026-11-05T12:00:00Z", since: "2026-11-05T11:59:00Z" };
  const { rerender } = renderWithI18n(<Label diagnostic={diagnostic} />, { locale: "zh-Hans" });
  expect(screen.getByText("该智能体并发已满 (6/6)")).toBeInTheDocument();
  fireEvent.click(screen.getByText("等待详情"));
  expect(screen.getByText("作用域")).toBeVisible();
  expect(screen.getByText("6/6")).toBeVisible();
  rerender(<Label diagnostic={diagnostic} status="running" />);
  expect(screen.queryByText(/6\/6/)).not.toBeInTheDocument();
});
it("does not interpret an absent or future reason as capacity pressure", () => {
  const { rerender } = renderWithI18n(<Label />);
  expect(screen.getByText("Waiting reason not reported")).toBeInTheDocument();
  rerender(<Label diagnostic={{ code: "new_server_reason", phase: "queued", scope: "run" }} />);
  expect(screen.getByText("Waiting reason not reported")).toBeInTheDocument();
});
