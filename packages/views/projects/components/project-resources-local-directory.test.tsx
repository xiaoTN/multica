// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import en from "../../locales/en/projects.json";
import type { ProjectResource } from "@multica/core/types";
import { toast } from "sonner";

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

let resources: ProjectResource[] = [RESOURCE as ProjectResource];
const platform = vi.hoisted(() => ({ supported: true, daemonId: "daemon-1" as string | null, running: true, externallyManaged: false }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options?.queryKey?.[0];
    if (key === "project-resources") return { data: resources };
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
  canOpenLocalDirectory: () => platform.supported,
  openLocalDirectory: vi.fn(),
}));
vi.mock("../../platform/use-local-daemon-status", () => ({
  useLocalDaemonStatus: () => ({ ...platform, deviceName: "MacBook" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { openLocalDirectory, pickDirectory, validateLocalDirectory } from "../../platform/local-directory";

import { ProjectResourcesSection } from "./project-resources-section";

const strings = en.resources;

describe("ProjectResourcesSection — local directory row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resources = [RESOURCE as ProjectResource];
    Object.assign(platform, { supported: true, daemonId: "daemon-1", running: true, externallyManaged: false });
    vi.mocked(openLocalDirectory).mockResolvedValue({ ok: true });
  });

  async function openMenu(name = "Game Client") {
    fireEvent.contextMenu(screen.getByLabelText(name));
    return screen.findByRole("menuitem", { name: strings.local_open_directory });
  }

  it("shows an unnamed directory's basename while opening its full path", async () => {
    resources = [{ ...RESOURCE, label: null, resource_ref: { local_path: "/work/中文 client/", daemon_id: "daemon-1" } } as ProjectResource];
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    expect(screen.getByText("中文 client")).toBeInTheDocument();
    fireEvent.click(await openMenu("中文 client"));
    await waitFor(() => expect(openLocalDirectory).toHaveBeenCalledWith("/work/中文 client/", "daemon-1"));
  });

  it("opens the original resource directory and closes the context menu", async () => {
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    fireEvent.click(await openMenu());
    await waitFor(() => expect(openLocalDirectory).toHaveBeenCalledWith(RESOURCE.resource_ref.local_path, "daemon-1"));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(createResource).not.toHaveBeenCalled();
  });

  it.each([
    ["web or older desktop", { supported: false }, strings.local_open_unsupported],
    ["another machine", { daemonId: "other" }, strings.local_other_machine_tooltip],
    ["unresolved daemon", { daemonId: null }, strings.toast_local_daemon_not_running],
    ["stopped daemon", { running: false }, strings.toast_local_daemon_not_running],
    ["forwarded daemon", { externallyManaged: true }, strings.local_other_machine_tooltip],
  ])("disables opening on %s and explains why", async (_name, state, reason) => {
    Object.assign(platform, state);
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    const item = await openMenu();
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(reason)).toBeInTheDocument();
    fireEvent.click(item);
    expect(openLocalDirectory).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: strings.mode_edit_tooltip })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.remove_tooltip })).toBeInTheDocument();
  });

  it("shows a missing-directory failure", async () => {
    vi.mocked(openLocalDirectory).mockResolvedValue({ ok: false, reason: "not_found" });
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    fireEvent.click(await openMenu());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(strings.toast_local_open_failed, { description: strings.local_validate_not_found }));
  });

  it("shows bridge errors instead of silently succeeding", async () => {
    vi.mocked(openLocalDirectory).mockRejectedValue(new Error("IPC disconnected"));
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    fireEvent.click(await openMenu());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(strings.toast_local_open_failed, { description: "IPC disconnected" }));
  });

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
