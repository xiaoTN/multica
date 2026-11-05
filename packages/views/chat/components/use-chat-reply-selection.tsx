"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_ANNOTATION_QUOTE_LENGTH } from "@multica/core/drafts/reply-annotation";
import { isImeComposing } from "@multica/core/utils";
import { Button } from "@multica/ui/components/ui/button";
import { MessageSquarePlus } from "@multica/ui/icons";
import { ReplyAnnotationNoteEditor } from "../../common/reply-annotation-note-editor";
import { captureTextSelection } from "../../common/text-selection";
import { TextSelectionBubble } from "../../common/text-selection-bubble";
import { useT } from "../../i18n";

type CapturedSelection = NonNullable<ReturnType<typeof captureTextSelection>>;

export function useChatReplySelection(onReplyAnnotation?: (quote: string, note: string) => void) {
  const { t } = useT("issues");
  const owner = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingFocus = useRef(false);
  const [selection, setSelection] = useState<CapturedSelection | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const editing = note !== null;
  const enabled = !!onReplyAnnotation;
  const highlightName = `chat-reply-${owner.replace(/[^a-zA-Z0-9-]/g, "")}`;

  const close = useCallback((restoreFocus = false) => {
    if (restoreFocus && selection?.root.isConnected) selection.root.focus({ preventScroll: true });
    setSelection(null); setNote(null); pendingFocus.current = false;
  }, [selection]);
  const focusNote = useCallback(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => { setSelection(null); setNote(null); }, [enabled]);
  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Element &&
        event.target.closest("[data-reply-annotation-overlay]")?.getAttribute("data-reply-annotation-overlay") === owner) return;
      if (event.type === "focusin" && event.target instanceof Node && selection.root.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImeComposing(event)) close(true);
    };
    const onSelectionChange = () => {
      // Focusing the note clears the native source range. Keep its saved anchor.
      if (!editing && window.getSelection()?.isCollapsed && !actionRef.current?.contains(document.activeElement)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [selection, owner, editing, close]);
  useEffect(() => {
    if (!selection || !editing || typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) return;
    CSS.highlights.set(highlightName, new Highlight(selection.range));
    return () => { CSS.highlights.delete(highlightName); };
  }, [selection, editing, highlightName]);

  const capture = () => {
    if (!enabled || !containerRef.current) return;
    setSelection(captureTextSelection(containerRef.current, window.getSelection(), {
      contentAttribute: "data-chat-reply-content", scopeAttribute: "data-chat-reply-scope",
    }));
    setNote(null);
  };
  const confirm = () => {
    if (!selection || !note?.trim()) return;
    if (!selection.root.isConnected || !selection.range.startContainer.isConnected) { close(); return; }
    window.getSelection()?.removeAllRanges();
    onReplyAnnotation?.(selection.quote, note.trim());
    close(true);
  };

  return {
    containerRef,
    captureProps: {
      "data-chat-reply-scope": owner,
      onPointerUp: (event: React.PointerEvent) => {
        if (event.target instanceof Element && !event.target.closest("button, input, textarea, [contenteditable=true]")) capture();
      },
      onKeyUp: (event: React.KeyboardEvent) => {
        if (event.shiftKey && event.key.startsWith("Arrow") && event.target instanceof Element &&
          event.target.closest("[data-chat-reply-content]")) capture();
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Tab" && !event.shiftKey && selection && !editing) {
          event.preventDefault(); actionRef.current?.focus();
        }
      },
    },
    popup: enabled && selection ? <>
      {editing && <style>{`::highlight(${highlightName}) { background: color-mix(in srgb, var(--brand) 20%, transparent); }`}</style>}
      <TextSelectionBubble range={selection.range} source={selection.root} owner={owner} onPositioned={focusNote}>
        <div className="bubble-menu max-w-[calc(100vw-16px)] focus-within:outline-1 focus-within:outline-ring">
          {note !== null ? <ReplyAnnotationNoteEditor inputRef={inputRef} note={note}
            confirmLabel={t(($) => $.reply.annotations.confirm_add)} onChange={setNote}
            onConfirm={confirm} onCancel={() => close(true)} /> :
            <Button ref={actionRef} type="button" variant="ghost" size="sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!selection.root.isConnected || !selection.range.startContainer.isConnected) { close(); return; }
                if (selection.quote.length > MAX_ANNOTATION_QUOTE_LENGTH) {
                  toast.error(t(($) => $.reply.annotations.quote_limit, { count: MAX_ANNOTATION_QUOTE_LENGTH }));
                  return;
                }
                pendingFocus.current = true;
                setNote("");
                window.getSelection()?.removeAllRanges();
              }}>
              <MessageSquarePlus />
              {t(($) => $.reply.annotations.add)}
            </Button>}
        </div>
      </TextSelectionBubble>
    </> : null,
  };
}
