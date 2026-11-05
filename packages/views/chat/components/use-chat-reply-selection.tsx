"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_ANNOTATION_QUOTE_LENGTH } from "@multica/core/drafts/reply-annotation";
import { isImeComposing } from "@multica/core/utils";
import { Button } from "@multica/ui/components/ui/button";
import { MessageSquarePlus } from "@multica/ui/icons";
import { captureTextSelection } from "../../common/text-selection";
import { TextSelectionBubble } from "../../common/text-selection-bubble";
import { useT } from "../../i18n";

type CapturedSelection = NonNullable<ReturnType<typeof captureTextSelection>>;

export function useChatReplySelection(onReplyQuote?: (quote: string) => void) {
  const { t } = useT("issues");
  const owner = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<CapturedSelection | null>(null);
  const enabled = !!onReplyQuote;

  useEffect(() => { setSelection(null); }, [enabled]);
  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Element &&
        event.target.closest("[data-reply-annotation-overlay]")?.getAttribute("data-reply-annotation-overlay") === owner) return;
      if (event.type === "focusin" && event.target instanceof Node && selection.root.contains(event.target)) return;
      setSelection(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImeComposing(event)) setSelection(null);
    };
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed && !actionRef.current?.contains(document.activeElement)) setSelection(null);
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
  }, [selection, owner]);

  const capture = () => {
    if (!enabled || !containerRef.current) return;
    setSelection(captureTextSelection(containerRef.current, window.getSelection(), {
      contentAttribute: "data-chat-reply-content", scopeAttribute: "data-chat-reply-scope",
    }));
  };

  return {
    containerRef,
    captureProps: {
      "data-chat-reply-scope": owner,
      onPointerUp: (event: React.PointerEvent) => {
        if (event.target instanceof Element && !event.target.closest("button, input, textarea, [contenteditable=true]")) capture();
      },
      onKeyUp: (event: React.KeyboardEvent) => {
        if (event.shiftKey && event.key.startsWith("Arrow")) capture();
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Tab" && !event.shiftKey && selection) {
          event.preventDefault(); actionRef.current?.focus();
        }
      },
    },
    popup: enabled && selection ? (
      <TextSelectionBubble range={selection.range} source={selection.root} owner={owner}>
        <div className="bubble-menu">
          <Button ref={actionRef} type="button" variant="ghost" size="sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!selection.root.isConnected || !selection.range.startContainer.isConnected) { setSelection(null); return; }
              if (selection.quote.length > MAX_ANNOTATION_QUOTE_LENGTH) {
                toast.error(t(($) => $.reply.annotations.quote_limit, { count: MAX_ANNOTATION_QUOTE_LENGTH }));
                return;
              }
              window.getSelection()?.removeAllRanges();
              onReplyQuote?.(selection.quote);
              setSelection(null);
            }}>
            <MessageSquarePlus />
            {t(($) => $.reply.annotations.add)}
          </Button>
        </div>
      </TextSelectionBubble>
    ) : null,
  };
}
