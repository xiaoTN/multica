import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createShortcutChord, getShortcut, useShortcutStore } from "@multica/core/shortcuts";
import { useAnnotationSendShortcut } from "./use-annotation-send-shortcut";

afterEach(() => useShortcutStore.getState().resetAll());

describe("annotation send shortcut", () => {
  it("uses Enter only while annotations exist and no send preference was set", () => {
    const { result, rerender } = renderHook(
      ({ annotated }) => useAnnotationSendShortcut(annotated),
      { initialProps: { annotated: false } },
    );
    expect(result.current).toEqual(getShortcut("send"));
    rerender({ annotated: true });
    expect(result.current).toEqual(createShortcutChord("Enter"));
    const custom = createShortcutChord("Enter", { primary: true });
    act(() => useShortcutStore.getState().setShortcut("send", custom));
    expect(result.current).toEqual(custom);
    act(() => useShortcutStore.getState().setShortcut("send", null));
    expect(result.current).toBeNull();
    act(() => useShortcutStore.getState().resetShortcut("send"));
    expect(result.current).toEqual(createShortcutChord("Enter"));
    rerender({ annotated: false });
    expect(result.current).toEqual(getShortcut("send"));
  });
});
