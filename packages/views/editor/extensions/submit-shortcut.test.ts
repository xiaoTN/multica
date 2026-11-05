import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor, Extension, type AnyExtension, type Content } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  createShortcutChord,
  configureShortcutPlatform,
  useShortcutStore,
  type ShortcutActionId,
} from "@multica/core/shortcuts";
import { PatchedListItem } from "./list-item";
import {
  createSubmitShortcutExtension,
  shouldHandleSubmitShortcut,
  shouldReplayNativeEnter,
} from "./submit-shortcut";

function event(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">> = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
}

function press(editor: Editor, keyboardEvent: KeyboardEvent): boolean {
  let handled = false;
  editor.view.someProp("handleKeyDown", (handler) => {
    if (!handler(editor.view, keyboardEvent)) return false;
    handled = true;
    return true;
  });
  return handled;
}

function makeEditor(
  content: Content,
  onSubmit: (actionId?: ShortcutActionId) => void,
  extraExtensions: AnyExtension[] = [],
  submitActions?: readonly ShortcutActionId[],
) {
  return new Editor({
    element: document.createElement("div"),
    content,
    extensions: [
      StarterKit.configure({ listItem: false }),
      PatchedListItem,
      Markdown,
      createSubmitShortcutExtension((actionId) => {
        onSubmit(actionId);
        return true;
      }, submitActions ? () => submitActions : undefined),
      ...extraExtensions,
    ],
  });
}

const editors: Editor[] = [];

beforeEach(() => {
  configureShortcutPlatform("windows");
});

describe("chat submit shortcuts", () => {
  it.each(["macos", "windows"] as const)("routes Enter and the primary Enter separately on %s", (platform) => {
    configureShortcutPlatform(platform);
    const submitted: (ShortcutActionId | undefined)[] = [];
    const editor = makeEditor("hello", (id) => submitted.push(id), [], ["chatSteer", "chatQueue"]);
    editors.push(editor);
    editor.commands.focus("end");
    expect(press(editor, event("Enter"))).toBe(true);
    expect(press(editor, event("Enter", platform === "macos" ? { metaKey: true } : { ctrlKey: true }))).toBe(true);
    expect(submitted).toEqual(["chatSteer", "chatQueue"]);
    expect(press(editor, event("Enter", { shiftKey: true }))).toBe(true);
    expect(submitted).toHaveLength(2);
    expect(editor.state.doc.childCount).toBe(2);
  });

  it("applies customized and disabled bindings without recreating the editor", () => {
    const submitted: (ShortcutActionId | undefined)[] = [];
    const editor = makeEditor("hello", (id) => submitted.push(id), [], ["chatSteer", "chatQueue"]);
    editors.push(editor);
    editor.commands.focus("end");
    useShortcutStore.getState().setShortcut("chatSteer", createShortcutChord("Enter", { primary: true, shift: true }));
    useShortcutStore.getState().setShortcut("chatQueue", null);
    expect(press(editor, event("Enter", { ctrlKey: true, shiftKey: true }))).toBe(true);
    press(editor, event("Enter", { ctrlKey: true }));
    expect(submitted).toEqual(["chatSteer"]);
    press(editor, event("Enter"));
    expect(editor.state.doc.childCount).toBe(2);
    expect(submitted).toEqual(["chatSteer"]);
  });

  it("does not send either action while confirming IME input or repeating a key", () => {
    const submitted: (ShortcutActionId | undefined)[] = [];
    const editor = makeEditor("hello", (id) => submitted.push(id), [], ["chatSteer", "chatQueue"]);
    editors.push(editor);
    const composingEnter = event("Enter");
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    const safariCommit = event("Enter", { ctrlKey: true });
    Object.defineProperty(safariCommit, "keyCode", { value: 229 });
    press(editor, composingEnter);
    press(editor, safariCommit);
    press(editor, event("Enter", { repeat: true }));
    expect(submitted).toEqual([]);
  });
});

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  useShortcutStore.getState().resetAll();
  configureShortcutPlatform(null);
});

describe("submit shortcut matching", () => {
  it("handles the configured shortcut exactly", () => {
    const shortcut = createShortcutChord("Enter", { primary: true });
    expect(
      shouldHandleSubmitShortcut(event("Enter", { ctrlKey: true }), {
        configuredShortcut: shortcut,
        composing: false,
      }),
    ).toBe(true);
    expect(
      shouldHandleSubmitShortcut(
        event("Enter", { ctrlKey: true, shiftKey: true }),
        { configuredShortcut: shortcut, composing: false },
      ),
    ).toBe(false);
  });

  it("does not submit while an IME composition is active", () => {
    expect(
      shouldHandleSubmitShortcut(event("Enter"), {
        configuredShortcut: createShortcutChord("Enter"),
        composing: true,
      }),
    ).toBe(false);
  });

  it("does not submit on Safari's IME commit event or a repeated keydown", () => {
    const safariImeCommit = event("Enter", { metaKey: true });
    Object.defineProperty(safariImeCommit, "keyCode", { value: 229 });
    expect(
      shouldHandleSubmitShortcut(safariImeCommit, {
        configuredShortcut: createShortcutChord("Enter", { primary: true }),
        composing: false,
      }),
    ).toBe(false);

    expect(
      shouldHandleSubmitShortcut(
        event("Enter", { ctrlKey: true, repeat: true }),
        {
          configuredShortcut: createShortcutChord("Enter", { primary: true }),
          composing: false,
        },
      ),
    ).toBe(false);
  });

  it("only remaps Shift+Enter when plain Enter is Send", () => {
    expect(
      shouldReplayNativeEnter(
        event("Enter", { shiftKey: true }),
        createShortcutChord("Enter"),
        false,
      ),
    ).toBe(true);
    expect(
      shouldReplayNativeEnter(
        event("Enter", { shiftKey: true }),
        createShortcutChord("Enter", { primary: true }),
        false,
      ),
    ).toBe(false);
  });
});

describe("Send = Enter editor behavior", () => {
  it("lets an open high-priority suggestion picker consume Enter first", () => {
    useShortcutStore.getState().setShortcut("send", createShortcutChord("Enter"));
    let submitCount = 0;
    let acceptCount = 0;
    const picker = Extension.create({
      name: "testSuggestionPicker",
      priority: 101,
      addProseMirrorPlugins() {
        return [new Plugin({
          props: {
            handleKeyDown: (_view, keyboardEvent) => {
              if (keyboardEvent.key !== "Enter") return false;
              acceptCount += 1;
              return true;
            },
          },
        })];
      },
    });
    const editor = makeEditor(
      "@al",
      () => { submitCount += 1; },
      [picker],
    );
    editors.push(editor);
    editor.commands.focus("end");

    expect(press(editor, event("Enter"))).toBe(true);
    expect(acceptCount).toBe(1);
    expect(submitCount).toBe(0);
  });

  it("submits on Enter and turns Shift+Enter into the old paragraph Enter", () => {
    useShortcutStore.getState().setShortcut("send", createShortcutChord("Enter"));
    let submitCount = 0;
    const editor = makeEditor("hello", () => { submitCount += 1; });
    editors.push(editor);
    editor.commands.focus("end");

    expect(press(editor, event("Enter"))).toBe(true);
    expect(submitCount).toBe(1);
    expect(editor.state.doc.childCount).toBe(1);

    expect(press(editor, event("Enter", { shiftKey: true }))).toBe(true);
    expect(submitCount).toBe(1);
    expect(editor.state.doc.childCount).toBe(2);
    let hasHardBreak = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "hardBreak") hasHardBreak = true;
    });
    expect(hasHardBreak).toBe(false);
  });

  it("continues list items with Shift+Enter", () => {
    useShortcutStore.getState().setShortcut("send", createShortcutChord("Enter"));
    let submitCount = 0;
    const editor = makeEditor(
      {
        type: "doc",
        content: [{
          type: "bulletList",
          content: [{
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
          }],
        }],
      },
      () => { submitCount += 1; },
    );
    editors.push(editor);
    editor.commands.focus("end");

    expect(press(editor, event("Enter", { shiftKey: true }))).toBe(true);
    expect(submitCount).toBe(0);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
  });

  it("inserts the original code-block newline with Shift+Enter", () => {
    useShortcutStore.getState().setShortcut("send", createShortcutChord("Enter"));
    let submitCount = 0;
    const editor = makeEditor(
      {
        type: "doc",
        content: [{
          type: "codeBlock",
          attrs: { language: null },
          content: [{ type: "text", text: "line" }],
        }],
      },
      () => { submitCount += 1; },
    );
    editors.push(editor);
    editor.commands.focus("end");

    expect(press(editor, event("Enter"))).toBe(true);
    expect(submitCount).toBe(1);
    expect(press(editor, event("Enter", { shiftKey: true }))).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe("line\n");
  });
});
