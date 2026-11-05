import { useCallback } from "react";
import { toast } from "sonner";
import { useT } from "../i18n";
import { pickLocalFilePaths, supportsLocalFilePaths } from "../platform/local-files";

export function useLocalFilePicker(onSelect: (file: File | string) => void, multiple: boolean) {
  const { t } = useT("editor");
  const pick = useCallback(async () => {
    try {
      const paths = await pickLocalFilePaths(multiple);
      for (const path of paths) onSelect(path);
    } catch (error) {
      toast.error(t(($) => $.upload.pick_failed, {
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [multiple, onSelect, t]);
  return supportsLocalFilePaths() ? pick : undefined;
}
