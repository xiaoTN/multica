"use client";

import { FileUploadButton as Button, type FileUploadButtonProps } from "@multica/ui/components/common/file-upload-button";
import { useT } from "../i18n";
import { useLocalFilePicker } from "./use-local-file-picker";

export function FileUploadButton({ onSelect, ...props }: Omit<FileUploadButtonProps, "onSelect" | "onPick"> & {
  onSelect: (file: File | string) => void;
}) {
  const { t } = useT("editor");
  const onPick = useLocalFilePicker(onSelect, props.multiple ?? false);
  return <Button {...props} onSelect={onSelect} onPick={onPick}
    label={onPick ? t(($) => $.upload.select_local) : undefined} />;
}
