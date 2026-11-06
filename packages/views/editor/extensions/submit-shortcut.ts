import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  getShortcut,
  isPlainShortcut,
  shortcutMatchesEvent,
  type ShortcutChord,
  type ShortcutActionId,
} from "@multica/core/shortcuts";
import { isImeComposing } from "@multica/core/utils";

export function shouldHandleSubmitShortcut(
  event: KeyboardEvent,
  options: {
    configuredShortcut: ShortcutChord | null;
    composing: boolean;
  },
): boolean {
  return (
    !event.repeat &&
    !options.composing &&
    !isImeComposing(event) &&
    shortcutMatchesEvent(options.configuredShortcut, event)
  );
}

/**
 * When plain Enter becomes Send, Shift+Enter must inherit the old Enter
 * behavior instead of Tiptap's normal hard-break behavior. Replaying the
 * editor's Enter keymap preserves paragraphs, patched list exit/continuation,
 * code-block newlines, and open suggestion pickers.
 */
export function shouldReplayNativeEnter(
  event: KeyboardEvent,
  configuredShortcut: ShortcutChord | null,
  composing: boolean,
): boolean {
  return (
    !composing &&
    !isImeComposing(event) &&
    isPlainShortcut(configuredShortcut, "Enter") &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

/**
 * Tiered-priority dynamic key handler. Suggestion and slash-command plugins
 * get first refusal, while submit still runs before the base editor keymap.
 */
export function createSubmitShortcutExtension(
  onSubmit: (actionId: ShortcutActionId) => boolean,
  getActions: () => readonly ShortcutActionId[] = () => ["send"],
  resolveShortcut: (action: ShortcutActionId) => ShortcutChord | null = getShortcut,
) {
  return Extension.create({
    name: "submitShortcut",
    // Mention/slash extensions use 101, so open pickers get first refusal.
    // Default editor keymaps use 100; reverse extension order places this
    // late-added handler ahead of them while keeping picker priority intact.
    priority: 100,
    addProseMirrorPlugins() {
      const editor = this.editor;
      let replayingEnter = false;
      return [
        new Plugin({
          props: {
            handleKeyDown(view, event) {
              if (replayingEnter) return false;
              const actions = getActions();
              // A held confirmation key can land in this editor after the
              // annotation popup closes. Consume repeats of send chords so
              // they neither submit nor fall through to paragraph insertion.
              if (event.repeat && !view.composing && !isImeComposing(event) &&
                actions.some((action) => shortcutMatchesEvent(resolveShortcut(action), event))) return true;

              if (
                actions.some((action) => shouldReplayNativeEnter(event, resolveShortcut(action), view.composing))
              ) {
                replayingEnter = true;
                try {
                  return editor.commands.keyboardShortcut("Enter");
                } finally {
                  replayingEnter = false;
                }
              }

              const action = actions.find((action) =>
                shouldHandleSubmitShortcut(event, {
                  configuredShortcut: resolveShortcut(action),
                  composing: view.composing,
                }),
              );
              return action ? onSubmit(action) : false;
            },
          },
        }),
      ];
    },
  });
}
