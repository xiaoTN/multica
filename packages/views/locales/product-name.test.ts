// @vitest-environment node

import { describe, expect, it } from "vitest";
import { WHATS_NEW_RELEASES } from "../whats-new/releases";
import { RESOURCES } from "./index";

function upstreamProductNames(value: unknown, path: string): string[] {
  if (typeof value === "string") return value.includes("Multica") ? [path] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    upstreamProductNames(child, `${path}.${key}`),
  );
}

describe("local web and desktop product name", () => {
  it.each(Object.entries(RESOURCES))(
    "keeps the local product name in %s copy after upstream merges",
    (locale, bundle) => {
      expect(upstreamProductNames(bundle, locale)).toEqual([]);
    },
  );

  it("keeps the local product name in release highlights", () => {
    const offenders = WHATS_NEW_RELEASES.flatMap((release) =>
      release.highlights.flatMap((highlight) =>
        upstreamProductNames(highlight.copy, `${release.version}.${highlight.id}`),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
