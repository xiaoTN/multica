// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import en from "../../locales/en/projects.json";

const { createResource } = vi.hoisted(() => ({ createResource: vi.fn().mockResolvedValue({}) }));

const RESOURCE = {
  id: "res-1",
  project_id: "p1",
  workspace_id: "workspace-1",
  resource_type: "local_directory",
  resource_ref: {
    local_path: "/Users/dev/work/game-client",
    daemon_id: "daemon-1",
    label: "game-client",
    execution_mode: "worktree",
  },
  // Written by a label update (`multica project resource update --label`):
  // the column the row must read before the copy left inside the ref.
  label: "Game Client",
  position: 0,
  created_at: "2026-08-18T00:00:00Z",
  created_by: "u1",
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options?.queryKey?.[0];
    if (key === "project-resources") return { data: [RESOURCE] };
    return { data: [] };
  },
  queryOptions: (options: unknown) => options,
}));

vi.mock("@multica/core/projects", () => ({
  projectResourcesOptions: () => ({ queryKey: ["project-resources"], queryFn: vi.fn() }),
  useCreateProjectResource: () => ({ mutateAsync: createResource }),
  useUpdateProjectResource: () => ({ mutateAsync: vi.fn() }),
  useDeleteProjectResource: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@multica/core/config", () => ({
  useConfigStore: (selector: (state: { localWorktreeSupported: boolean }) => unknown) =>
    selector({ localWorktreeSupported: true }),
}));

vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"], queryFn: vi.fn() }),
  runtimeAdvertisesLocalWorktree: () => true,
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "workspace-1", slug: "ws", repos: [] }),
}));
vi.mock("../../platform/local-directory", () => ({
  isDesktopShell: () => true,
  pickDirectory: vi.fn(),
  validateLocalDirectory: vi.fn(),
}));
vi.mock("../../platform/use-local-daemon-status", () => ({
  useLocalDaemonStatus: () => ({ daemonId: "daemon-1", deviceName: "MacBook", running: true }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { pickDirectory, validateLocalDirectory } from "../../platform/local-directory";

import { ProjectResourcesSection } from "./project-resources-section";

const strings = en.resources;

describe("ProjectResourcesSection — local directory row", () => {
  it("已有一个本地仓库时还能继续添加另一个仓库", async () => {
    vi.mocked(pickDirectory).mockResolvedValue({ ok: true, path: "/work/backend", basename: "backend" });
    vi.mocked(validateLocalDirectory).mockResolvedValue({ ok: true, is_git_repo: true });
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    const add = screen.getByRole("button", { name: strings.add_local_directory_button });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText("/work/backend")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: strings.mode_add }));
    await waitFor(() => expect(createResource).toHaveBeenCalledWith({
      resource_type: "local_directory",
      resource_ref: { local_path: "/work/backend", daemon_id: "daemon-1", label: "backend", execution_mode: "worktree" },
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  // The read-order matrix lives in local-directory-label.test.ts; this pins
  // the row to that helper so a label set through the API is what people see.
  it("names the row from the top-level label, not the copy inside the ref", () => {
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    expect(screen.getByText("Game Client")).toBeInTheDocument();
    expect(screen.queryByText("game-client")).not.toBeInTheDocument();
  });

  // The row used to carry a pencil that turned the name into a text box. A
  // folder is identified by its path, so the only thing that "edit" changed
  // was the row's title, and beside the branch and remove controls it read as
  // a broken edit action (MUL-7525). What remains are the two settings that
  // change how tasks run on the folder.
  it("offers the execution mode and remove actions, and no rename", () => {
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    expect(screen.getByRole("button", { name: strings.mode_edit_tooltip })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.remove_tooltip })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
