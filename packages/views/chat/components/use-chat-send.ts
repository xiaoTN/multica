"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@multica/core/api";
import { useCommentComposerStore, type RunningAgentReply } from "@multica/core/issues/stores/comment-composer-store";
import { toast } from "sonner";
import { useT } from "../../i18n";

export function useChatSend(sessionId: string | null) {
  const { t } = useT("chat");
  const preferred = useCommentComposerStore((s) => s.runningAgentReply);
  const [override, setSendMode] = useState<RunningAgentReply | null>(null);
  const sendMode = override ?? preferred;
  useEffect(() => setSendMode(null), [sessionId, preferred]);

  const sendMessage = useCallback(async (
    targetSessionId: string, content: string, attachmentIds: string[] | undefined,
    pendingTaskId: string | null,
  ) => {
    try {
      const result = pendingTaskId
        ? await api.sendChatMessage(targetSessionId, content, attachmentIds, {
            mode: sendMode === "steer" ? "steer" : "queue", expectedTaskId: pendingTaskId,
          })
        : await api.sendChatMessage(targetSessionId, content, attachmentIds);
      if (pendingTaskId && sendMode === "steer" && !result.steered) {
        toast.info(t(($) => $.input.steer_queued));
      }
      return result;
    } catch (err) {
      if (pendingTaskId && sendMode === "steer" && err instanceof ApiError && err.status === 409) {
        toast.error(t(($) => $.input.steer_unavailable));
        return null;
      }
      throw err;
    }
  }, [sendMode, t]);
  return { sendMode, setSendMode, sendMessage };
}
