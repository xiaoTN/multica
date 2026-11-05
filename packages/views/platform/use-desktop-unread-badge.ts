import { useEffect } from "react";
import { useInboxUnreadCount } from "@multica/core/inbox/queries";

type BadgeCapableAPI = {
  setUnreadBadge?: (count: number) => void;
};

function getDesktopAPI(): BadgeCapableAPI | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { desktopAPI?: BadgeCapableAPI }).desktopAPI;
}

/**
 * Mirror the inbox unread count onto the OS dock/taskbar badge. No-op on web
 * (no `desktopAPI`). Clear this window's contribution when leaving the shell,
 * including logout. The badge stays on screen while the window is minimized,
 * so it keeps the summary live then.
 */
export function useDesktopUnreadBadge(wsId: string | null | undefined): void {
  const count = useInboxUnreadCount(wsId, { whileHidden: true });
  useEffect(() => {
    getDesktopAPI()?.setUnreadBadge?.(count);
  }, [count]);

  useEffect(() => {
    const api = getDesktopAPI();
    return () => api?.setUnreadBadge?.(0);
  }, []);
}
