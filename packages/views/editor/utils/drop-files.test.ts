// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { filesFromDrop } from "./drop-files";

function transfer(files: File[], items?: object[]) {
  return { files, items } as unknown as DataTransfer;
}

describe("filesFromDrop", () => {
  it("keeps ordinary and empty files when entry metadata is unavailable", () => {
    const files = [new File(["example"], "a.txt"), new File([], "empty.txt")];
    const warn = vi.fn();
    expect(filesFromDrop(transfer(files), warn)).toEqual(files);
    expect(filesFromDrop(transfer(files, [
      { kind: "file" },
      { kind: "file", webkitGetAsEntry: () => null },
    ]), warn)).toEqual(files);
    expect(warn).not.toHaveBeenCalled();
  });

  it("filters every directory without losing adjacent files or confusing string items", () => {
    const file = new File(["example"], "a.txt");
    const warn = vi.fn();
    const files = filesFromDrop(transfer([new File([], "photos"), file, new File([], "documents")], [
      { kind: "string" },
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "photos" }) },
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false, name: "a.txt" }) },
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "documents" }) },
    ]), warn);

    expect(files).toEqual([file]);
    expect(warn.mock.calls).toEqual([["photos"], ["documents"]]);
  });

  it("returns no uploadable files for a directory-only drop", () => {
    expect(filesFromDrop(transfer([new File([], "photos")], [
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "photos" }) },
    ]))).toEqual([]);
  });
});
