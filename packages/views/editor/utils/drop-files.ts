/** Read entry metadata during the drop event, while the drag data is accessible. */
export function filesFromDrop(
  dataTransfer: DataTransfer,
  onDirectory?: (name: string) => void,
): File[] {
  const directoryIndexes = new Set<number>();
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
  items.forEach((item, index) => {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      directoryIndexes.add(index);
      onDirectory?.(entry.name);
    }
  });
  // Chromium exposes dropped directories in FileList too, but trying to send
  // those File objects as multipart data fails with net::ERR_ACCESS_DENIED.
  return Array.from(dataTransfer.files).filter((_, index) => !directoryIndexes.has(index));
}
