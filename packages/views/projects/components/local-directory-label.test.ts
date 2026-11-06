// @vitest-environment node

import { describe, it, expect } from "vitest";
import { localDirectoryLabel } from "./local-directory-label";

// Canonical priority matrix for the display name of a local_directory row.
// The component suite (project-resources-local-directory.test.tsx) keeps the wiring
// and named regressions; the read-order truth lives here.
describe("localDirectoryLabel", () => {
  const ref = (overrides: Partial<{ label: string }> = {}) => ({
    local_path: "/Users/dev/work/game-client",
    daemon_id: "d1",
    ...overrides,
  });

  it("prefers the top-level column — where label updates write — over the ref copy", () => {
    expect(
      localDirectoryLabel({
        label: "Renamed Client",
        resource_ref: ref({ label: "Game Client" }),
      }),
    ).toBe("Renamed Client");
  });

  it("falls back to the ref copy: rows created by older clients have no column", () => {
    expect(
      localDirectoryLabel({
        label: null,
        resource_ref: ref({ label: "Game Client" }),
      }),
    ).toBe("Game Client");
  });

  it("uses the directory name when neither copy names the row", () => {
    expect(
      localDirectoryLabel({ label: null, resource_ref: ref() }),
    ).toBe("game-client");
  });

  it("treats whitespace-only labels as absent instead of rendering a blank row", () => {
    expect(
      localDirectoryLabel({ label: "   ", resource_ref: ref() }),
    ).toBe("game-client");
  });

  it("trims the winning value", () => {
    expect(
      localDirectoryLabel({
        label: "  Renamed Client  ",
        resource_ref: ref({ label: "Game Client" }),
      }),
    ).toBe("Renamed Client");
  });

  it("skips a blank column when the ref has a custom label", () => {
    expect(localDirectoryLabel({ label: "  ", resource_ref: ref({ label: " My client " }) })).toBe("My client");
  });

  it.each([
    ["/Users/xiaoti/CodeRepo/agent-image-review", "agent-image-review"],
    ["/Users/xiaoti/CodeRepo/multica/", "multica"],
    ["/projects/中文 目录///", "中文 目录"],
    ["/projects/ name with spaces /", " name with spaces "],
    ["/projects/a\\b/", "a\\b"],
    ["C:\\projects\\中文 目录\\", "中文 目录"],
    ["D:/projects/client/", "client"],
    ["\\\\host\\share\\client\\", "client"],
    ["/", "/"],
    ["C:\\", "C:\\"],
  ])("extracts the name of %s without changing the stored path", (path, expected) => {
    const resource = { label: null, resource_ref: { ...ref(), local_path: path } };
    expect(localDirectoryLabel(resource)).toBe(expected);
    expect(resource.resource_ref.local_path).toBe(path);
  });
});
