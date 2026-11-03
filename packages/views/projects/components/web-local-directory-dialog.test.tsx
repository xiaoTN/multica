// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { AgentRuntime } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { WebLocalDirectoryDialog } from "./web-local-directory-dialog";
import en from "../../locales/en/projects.json";

function runtime(daemonId = "daemon-1"): AgentRuntime {
  return {
    id: `runtime-${daemonId}`, workspace_id: "ws-1", daemon_id: daemonId,
    name: "Codex (dev-machine.local)", provider: "codex", runtime_mode: "local", launch_header: "",
    status: "online", device_info: "dev-machine.local · codex", metadata: {}, owner_id: "user-1", visibility: "private",
    last_seen_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

const text = en.resources;

describe("网页关联本地仓库", () => {
  it("将路径和所选电脑一起保存，成功后关闭", async () => {
    const onCreate = vi.fn().mockResolvedValue({}); const onClose = vi.fn();
    renderWithI18n(<WebLocalDirectoryDialog runtimes={[runtime()]} worktreeSupported onCreate={onCreate} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(text.web_local_path), { target: { value: " /work/backend with spaces " } });
    fireEvent.click(screen.getByRole("button", { name: text.mode_add }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenCalledWith({ local_path: "/work/backend with spaces", daemon_id: "daemon-1", label: "backend with spaces", execution_mode: "in_place" });
  });

  it("保存失败后保留路径和执行方式，允许重试", async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error("directory already attached")).mockResolvedValueOnce({});
    const onClose = vi.fn();
    renderWithI18n(<WebLocalDirectoryDialog runtimes={[runtime()]} worktreeSupported onCreate={onCreate} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(text.web_local_path), { target: { value: "/work/backend" } });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(text.mode_worktree_title) }));
    fireEvent.click(screen.getByRole("button", { name: text.mode_add }));
    expect(await screen.findByRole("alert")).toHaveTextContent("directory already attached");
    expect(screen.getByLabelText(text.web_local_path)).toHaveValue("/work/backend");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: text.mode_add }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ execution_mode: "worktree" }));
  });

  it("路径不完整时指出问题并聚焦输入框", () => {
    const onCreate = vi.fn();
    renderWithI18n(<WebLocalDirectoryDialog runtimes={[runtime()]} worktreeSupported onCreate={onCreate} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(text.web_local_path), { target: { value: "relative/backend" } });
    fireEvent.click(screen.getByRole("button", { name: text.mode_add }));
    expect(screen.getByRole("alert")).toHaveTextContent(text.local_validate_not_absolute);
    expect(screen.getByLabelText(text.web_local_path)).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("没有在线电脑时显示下一步并阻止提交", () => {
    renderWithI18n(<WebLocalDirectoryDialog runtimes={[]} worktreeSupported onCreate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(text.web_local_no_machine);
    expect(screen.getByRole("button", { name: text.mode_add })).toBeDisabled();
  });

  it("有多个运行电脑时要求明确选择", () => {
    renderWithI18n(<WebLocalDirectoryDialog runtimes={[runtime(), runtime("daemon-2")]} worktreeSupported onCreate={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(text.web_local_path), { target: { value: "/work/backend" } });
    expect(screen.getByRole("button", { name: text.mode_add })).toBeDisabled();
  });
});
