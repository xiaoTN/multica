import { locateReplyAnnotation, type ReplyAnnotation } from "@multica/core/drafts/reply-annotation";

import { captureTextSelection, indexRenderedText } from "../../common/text-selection";

export function captureCommentSelection(card: HTMLElement, selection: Selection | null, editable = false) {
  const captured = captureTextSelection(card, selection, {
    contentAttribute: "data-comment-content", scopeAttribute: "data-annotation-thread", editable,
  });
  if (!captured) return null;
  const { sourceId, ...rest } = captured;
  return { ...rest, sourceCommentId: sourceId };
}

export function annotationRange(root: HTMLElement, annotation: ReplyAnnotation, editable = false): Range | null {
  const { text, nodes } = indexRenderedText(root, editable);
  const start = locateReplyAnnotation(text, annotation);
  if (start === null) return null;
  const end = start + annotation.quote.length;
  const first = nodes.find((n) => n.start <= start && n.end > start);
  const last = nodes.find((n) => n.start < end && n.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

export function findAnnotationSource(card: HTMLElement, sourceCommentId: string): HTMLElement | undefined {
  return Array.from(card.querySelectorAll<HTMLElement>("[data-comment-content]"))
    .find((node) => node.dataset.commentContent === sourceCommentId && node.closest("[data-annotation-thread]") === card);
}
