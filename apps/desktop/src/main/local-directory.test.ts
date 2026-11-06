// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { constants } from "fs";
import { setupLocalDirectory } from "./local-directory";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  showOpenDialog: vi.fn(),
  fromWebContents: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
  openPath: vi.fn(),
  isAuthorizedSender: vi.fn(),
  getDaemonStatus: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  shell: { openPath: mocks.openPath },
}));
vi.mock("fs/promises", () => ({ stat: mocks.stat, access: mocks.access }));

const frame = {};
const event = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
function invoke(channel: string, path?: unknown, daemonId?: string, source = event) {
  const handler = mocks.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler(source, path, daemonId);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fromWebContents.mockReturnValue({});
  mocks.isAuthorizedSender.mockReturnValue(true);
  mocks.getDaemonStatus.mockResolvedValue({ state: "running", daemonId: "d1" });
  setupLocalDirectory(() => null, mocks);
});

describe("local directory opening IPC", () => {
  it.each([null, {}])("rejects detached frames and embedded documents: %j", async (senderFrame) => {
    const source = { ...event, senderFrame } as IpcMainInvokeEvent;
    await expect(invoke("local-directory:open", "/projects/demo", "d1", source)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.getDaemonStatus).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("hands the original path to the system as data and only requires read access", async () => {
    const path = "/projects/中文 repo $(touch ignored)/";
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
    mocks.access.mockResolvedValue(undefined);
    mocks.openPath.mockResolvedValue("");
    await expect(invoke("local-directory:open", path, "d1")).resolves.toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledWith(path);
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith(path, constants.R_OK);
  });

  it("rejects unauthorized senders before accessing the daemon or filesystem", async () => {
    mocks.isAuthorizedSender.mockReturnValue(false);
    await expect(invoke("local-directory:open", "/projects/demo", "d1")).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.getDaemonStatus).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it.each([
    { state: "running", daemonId: "another-machine" },
    { state: "stopped" },
    { state: "running" },
    { state: "running", daemonId: "d1", externallyManaged: true },
  ])("does not interpret an unavailable daemon's path on the desktop: %j", async (status) => {
    mocks.getDaemonStatus.mockResolvedValue(status);
    await expect(invoke("local-directory:open", "/projects/demo", "d1")).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it.each([undefined, 42, "", "relative/path", "file:///projects/demo", "/projects/\0demo"])("rejects invalid input %j", async (path) => {
    await expect(invoke("local-directory:open", path, "d1")).resolves.toEqual({ ok: false, reason: "not_absolute" });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("reports a missing directory without opening or creating anything", async () => {
    mocks.stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(invoke("local-directory:open", "/projects/missing", "d1")).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("rejects files instead of launching them", async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(invoke("local-directory:open", "/projects/file", "d1")).resolves.toEqual({ ok: false, reason: "not_a_directory" });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("reports unreadable directories", async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
    mocks.access.mockRejectedValue(new Error("denied"));
    await expect(invoke("local-directory:open", "/projects/demo", "d1")).resolves.toEqual({ ok: false, reason: "not_readable" });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it.each(["message", "rejection"])("reports native open failures via %s", async (failure) => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
    mocks.access.mockResolvedValue(undefined);
    if (failure === "message") mocks.openPath.mockResolvedValue("Finder unavailable");
    else mocks.openPath.mockRejectedValue(new Error("Finder unavailable"));
    await expect(invoke("local-directory:open", "/projects/demo", "d1")).resolves.toEqual({ ok: false, reason: "error", error: "Finder unavailable" });
  });
});

describe("local file path picker IPC", () => {
  it("returns selected paths without reading or uploading their contents", async () => {
    const paths = ["/data/photo.png", "/data/photos"];
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: paths });
    await expect(invoke("local-files:pick", true)).resolves.toEqual(paths);
    expect(mocks.showOpenDialog).toHaveBeenCalledWith({}, {
      properties: ["openFile", ...(process.platform === "darwin" ? ["openDirectory"] : []), "multiSelections"],
    });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("returns no paths when cancelled", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: ["/data/photo.png"] });
    await expect(invoke("local-files:pick")).resolves.toEqual([]);
  });
});

describe("local directory picker IPC", () => {
  it("returns the selected folder and requests one directory with a starting path", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/projects/demo"] });
    await expect(invoke("local-directory:pick", "/projects")).resolves.toEqual({
      ok: true, path: "/projects/demo", basename: "demo",
    });
    expect(mocks.showOpenDialog).toHaveBeenCalledWith({}, {
      properties: ["openDirectory", "createDirectory"], defaultPath: "/projects",
    });
  });

  it.each([
    { canceled: true, filePaths: ["/projects/demo"] },
    { canceled: false, filePaths: [] },
  ])("preserves cancellation for %j", async (result) => {
    mocks.showOpenDialog.mockResolvedValue(result);
    await expect(invoke("local-directory:pick")).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  it("reports native dialog errors", async () => {
    mocks.showOpenDialog.mockRejectedValue(new Error("Dialog unavailable"));
    await expect(invoke("local-directory:pick")).resolves.toEqual({
      ok: false, reason: "error", error: "Dialog unavailable",
    });
  });
});

describe("local directory validation IPC", () => {
  it("accepts a readable and writable directory", async () => {
    mocks.stat.mockResolvedValueOnce({ isDirectory: () => true }).mockRejectedValue(new Error("No git entry"));
    mocks.access.mockResolvedValue(undefined);
    await expect(invoke("local-directory:validate", "/projects/demo")).resolves.toEqual({
      ok: true, is_git_repo: false,
    });
    expect(mocks.access).toHaveBeenCalledWith("/projects/demo", constants.R_OK);
    expect(mocks.access).toHaveBeenCalledWith("/projects/demo", constants.W_OK);
  });

  it("rejects files even if returned by a broken native picker", async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(invoke("local-directory:validate", "/projects/file.txt")).resolves.toEqual({
      ok: false, reason: "not_a_directory",
    });
  });

  it.each([
    [constants.R_OK, "not_readable"],
    [constants.W_OK, "not_writable"],
  ])("preserves permission failure %s", async (mode, reason) => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
    mocks.access.mockImplementation(async (_path, requestedMode) => {
      if (requestedMode === mode) throw new Error("Permission denied");
    });
    await expect(invoke("local-directory:validate", "/projects/demo")).resolves.toEqual({ ok: false, reason });
  });
});
