import { useState, useEffect, useCallback, useRef, type DragEvent } from "react";
import { filesFromDrop } from "./utils/drop-files";
import { useDirectoryDropWarning } from "./use-directory-drop-warning";

interface UseFileDropZoneOptions {
  onDrop: (files: File[]) => void;
  enabled?: boolean;
}

function useFileDropZone({ onDrop, enabled = true }: UseFileDropZoneOptions) {
  const [isDragOver, setIsDragOver] = useState(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const warnDirectory = useDirectoryDropWarning();

  // Clear on any document-level drop or dragend (e.g. user drops outside the zone)
  useEffect(() => {
    if (!enabled) return;
    const clear = () => setIsDragOver(false);
    document.addEventListener("drop", clear);
    document.addEventListener("dragend", clear);
    return () => {
      document.removeEventListener("drop", clear);
      document.removeEventListener("dragend", clear);
    };
  }, [enabled]);

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (enabled && e.dataTransfer.types.includes("Files")) {
        setIsDragOver(true);
      }
    },
    [enabled],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      const alreadyHandled = e.nativeEvent.defaultPrevented;
      e.preventDefault();
      setIsDragOver(false);
      if (alreadyHandled || !enabled) return;
      if (e.dataTransfer?.files.length) {
        const files = filesFromDrop(e.dataTransfer, warnDirectory);
        if (files.length) onDropRef.current(files);
      }
    },
    [enabled, warnDirectory],
  );

  const dropZoneProps = {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  return { isDragOver: enabled && isDragOver, dropZoneProps };
}

export { useFileDropZone };
