"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pendingChatTaskOptions } from "@multica/core/chat/queries";
import { api, ApiError } from "@multica/core/api";
import { useCommentComposerStore, type RunningAgentReply } from "@multica/core/issues/stores/comment-composer-store";
import { toast } from "sonner";
import { useT } from "../../i18n";

export function useChatSend(sessionId: string | null) {
  const { t } = useT("chat");
  const qc = useQueryClient();
  const preferred = useCommentComposerStore((s) => s.runningAgentReply);
  const [override, setSendMode] = useState<RunningAgentReply | null>(null);
  const sendMode = override ?? preferred;
  useEffect(() => setSendMode(null), [sessionId, preferred]);

  const sendMessage = useCallback(async (
    targetSessionId: string, content: string, attachmentIds: string[] | undefined,
    pendingTaskId: string | null,
  ) => {
    let targetTaskId = pendingTaskId;
    try {
      // An empty cache during hydration does not prove the conversation is idle.
      if (!targetTaskId) {
        const pending = await qc.fetchQuery({ ...pendingChatTaskOptions(targetSessionId), staleTime: 0 });
        targetTaskId = pending?.task_id ?? null;
      }
      const result = targetTaskId
        ? await api.sendChatMessage(targetSessionId, content, attachmentIds, {
            mode: sendMode === "steer" ? "steer" : "queue", expectedTaskId: targetTaskId,
          })
        : await api.sendChatMessage(targetSessionId, content, attachmentIds);
      if (targetTaskId && sendMode === "steer" && !result.steered) {
        toast.info(t(($) => $.input.steer_queued));
      }
      return result;
    } catch (err) {
      if (targetTaskId && sendMode === "steer" && err instanceof ApiError && err.status === 409) {
        toast.error(t(($) => $.input.steer_unavailable));
        return null;
      }
      throw err;
    }
  }, [qc, sendMode, t]);
  return { sendMode, setSendMode, sendMessage };
}
