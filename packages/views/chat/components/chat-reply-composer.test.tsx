import { createRef } from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { createChatStore, registerChatStore, useChatStore } from "@multica/core/chat";
import type { Editor } from "@tiptap/core";
import enCommon from "../../locales/en/common.json";
import enChat from "../../locales/en/chat.json";
import enEditor from "../../locales/en/editor.json";
import { ChatInput, type ChatInputRef } from "./chat-input";

const live = vi.hoisted(() => ({ editor: null as Editor | null }));
// Exercise the real Tiptap document and debounce with only the extensions
// needed for text/quotes. Menus, uploads and mention lookups are unrelated.
vi.mock("../../editor/extensions", async () => {
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { Markdown } = await import("@tiptap/markdown");
  return { createEditorExtensions: () => [StarterKit, Markdown] };
});
vi.mock("@tiptap/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tiptap/react")>();
  return { ...real, useEditor: (...args: Parameters<typeof real.useEditor>) => {
    const editor = real.useEditor(...args);
    live.editor = editor;
    return editor;
  } };
});
vi.mock("../../editor/bubble-menu", () => ({ EditorBubbleMenu: () => null }));
vi.mock("./chat-add-menu", () => ({ ChatAddMenu: () => null }));

beforeEach(() => {
  registerChatStore(createChatStore({ storage: {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  } }));
  useChatStore.getState().setActiveSession("session-a");
});

function fixture(disabled = false) {
  const ref = createRef<ChatInputRef>();
  const onSend = vi.fn();
  render(
    <I18nProvider locale="en" resources={{ en: { common: enCommon, chat: enChat, editor: enEditor } }}>
      <QueryClientProvider client={new QueryClient()}>
        <ChatInput ref={ref} onSend={onSend} disabled={disabled} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ref, onSend };
}

describe("chat reply composer with real Tiptap", () => {
  it("preserves unflushed typing, appends consecutive quotes, and sends the quote with a reply outside it", async () => {
    const { ref, onSend } = fixture();
    await waitFor(() => expect(live.editor).not.toBeNull());
    act(() => {
      live.editor!.commands.insertContent("Unsaved draft");
      ref.current!.addReplyAnnotation("First **literal** line\nSecond line", "First **opinion**\nwith details");
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(useChatStore.getState().inputDrafts["session-a"]).toContain("Unsaved draft");
    expect(document.querySelector("blockquote")?.textContent).toBe("First **literal** line\nSecond line");
    expect(live.editor!.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(live.editor!.state.selection.$from.depth).toBe(1);
    act(() => {
      live.editor!.commands.insertContent("First reply");
      ref.current!.addReplyAnnotation("Another quote", "Second note");
      live.editor!.commands.insertContent("Final reply");
    });
    expect(document.querySelectorAll("blockquote")).toHaveLength(2);
    expect(document.querySelectorAll("blockquote")[1]?.textContent).toBe("Another quote");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const sent = onSend.mock.calls[0]![0];
    expect(sent).toContain("Unsaved draft");
    expect(sent).toContain("> First");
    expect(sent).toContain("> Second line");
    expect(sent).toContain("First **opinion**");
    expect(sent).toContain("Second note");
    expect(sent).toContain("First reply");
    expect(sent).toContain("Final reply");
  });

  it("ignores additions to a disabled composer", async () => {
    const { ref } = fixture(true);
    await waitFor(() => expect(live.editor).not.toBeNull());
    act(() => ref.current!.addReplyAnnotation("Do not insert", "Note"));
    expect(document.querySelector("blockquote")).toBeNull();
    expect(useChatStore.getState().inputDrafts).toEqual({});
  });
});
