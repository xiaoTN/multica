import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enEditor from "../locales/en/editor.json";
import { FileUploadButton } from "./file-upload-button";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

afterEach(() => {
  Reflect.deleteProperty(window, "desktopAPI");
  vi.clearAllMocks();
});

function setup(pick: () => Promise<string[]>) {
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: {
    getPathForFile: vi.fn(), pickFilePaths: pick,
  } });
  const onSelect = vi.fn();
  render(<I18nProvider locale="en" resources={{ en: { editor: enEditor } }}>
    <FileUploadButton multiple onSelect={onSelect} />
  </I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Select local files or folders" }));
  return onSelect;
}

describe("desktop file selection", () => {
  it("passes each selected path to the composer", async () => {
    const paths = ["/data/家 照片", "/data/example.png"];
    const pick = vi.fn().mockResolvedValue(paths);
    const onSelect = setup(pick);
    await waitFor(() => expect(onSelect.mock.calls).toEqual(paths.map((path) => [path])));
    expect(pick).toHaveBeenCalledWith(true);
  });

  it("keeps the composer unchanged when the picker is cancelled", async () => {
    const pick = vi.fn().mockResolvedValue([]);
    const onSelect = setup(pick);
    await waitFor(() => expect(pick).toHaveBeenCalled());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reports picker errors", async () => {
    const onSelect = setup(vi.fn().mockRejectedValue(new Error("Dialog unavailable")));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn’t select files: Dialog unavailable"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
