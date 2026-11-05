interface DesktopLocalFilesAPI {
  getPathForFile: (file: File) => string;
  pickFilePaths: (multiple: boolean) => Promise<string[]>;
}

function localFilesAPI(): DesktopLocalFilesAPI | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { desktopAPI?: DesktopLocalFilesAPI }).desktopAPI;
}

export function supportsLocalFilePaths(): boolean {
  return typeof localFilesAPI()?.getPathForFile === "function";
}

export function getLocalFilePath(file: File): string {
  return localFilesAPI()?.getPathForFile?.(file) ?? "";
}

export function pickLocalFilePaths(multiple: boolean): Promise<string[]> {
  return localFilesAPI()!.pickFilePaths(multiple);
}
