import { useCallback } from "react";
import { toast } from "sonner";
import { useT } from "../i18n";

export function useDirectoryDropWarning() {
  const { t } = useT("editor");
  return useCallback((filename: string) => {
    toast.error(t(($) => $.upload.directory, { filename }));
  }, [t]);
}
