"use client";

import { createShortcutChord, resolveShortcut, useShortcutStore } from "@multica/core/shortcuts";

const ANNOTATION_SEND = createShortcutChord("Enter");

/** Pending annotations support two Enters without replacing an explicit preference. */
export function useAnnotationSendShortcut(hasAnnotations: boolean) {
  return useShortcutStore((state) =>
    hasAnnotations && !Object.prototype.hasOwnProperty.call(state.overrides, "send")
      ? ANNOTATION_SEND
      : resolveShortcut(state.overrides, "send"),
  );
}
