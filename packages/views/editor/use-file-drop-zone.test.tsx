import { act, renderHook } from "@testing-library/react";
import type { DragEvent, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import enEditor from "../locales/en/editor.json";
import { useFileDropZone } from "./use-file-drop-zone";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={{ en: { editor: enEditor } }}>{children}</I18nProvider>;
}

function dropEvent() {
  const directory = new File([], "photos");
  const file = new File(["synthetic"], "example.txt");
  return {
    preventDefault: vi.fn(),
    nativeEvent: { defaultPrevented: false },
    dataTransfer: {
      files: [directory, file],
      items: [
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "photos" }) },
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false, name: "example.txt" }) },
      ],
    },
  } as unknown as DragEvent;
}

describe("useFileDropZone", () => {
  it("forwards folders directly to the editor on desktop without ZIP guidance", () => {
    toastError.mockClear();
    Object.defineProperty(window, "desktopAPI", { configurable: true, value: { getPathForFile: vi.fn() } });
    try {
      const onDrop = vi.fn();
      const { result } = renderHook(() => useFileDropZone({ onDrop }), { wrapper });
      const event = dropEvent();
      act(() => result.current.dropZoneProps.onDrop(event));
      expect(onDrop).toHaveBeenCalledWith(Array.from(event.dataTransfer.files));
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, "desktopAPI");
    }
  });

  it("explains how to upload a folder and still forwards ordinary files", () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => useFileDropZone({ onDrop }), { wrapper });
    const event = dropEvent();

    act(() => result.current.dropZoneProps.onDrop(event));

    expect(onDrop).toHaveBeenCalledWith([event.dataTransfer.files[1]]);
    expect(toastError).toHaveBeenCalledWith("Compress photos into a ZIP file before uploading it.");
  });

  it.each(["disabled", "handled"])("does not process a %s drop", (mode) => {
    toastError.mockClear();
    const onDrop = vi.fn();
    const { result } = renderHook(() => useFileDropZone({ onDrop, enabled: mode !== "disabled" }), { wrapper });
    const event = dropEvent();
    Object.defineProperty(event.nativeEvent, "defaultPrevented", { value: mode === "handled" });

    act(() => result.current.dropZoneProps.onDrop(event));

    expect(onDrop).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
