import { describe, expect, it } from "vitest";
import { dirname, normalizePath, resolveRelative, resolveTargetRef } from "../../src/epub/parser.js";

describe("path helpers", function () {
  it("normalizes separators and dot segments", function () {
    expect(normalizePath("OPS\\Text/./chapter1.xhtml")).toBe("OPS/Text/chapter1.xhtml");
    expect(normalizePath("OPS/Text/../Images/cover.jpg")).toBe("OPS/Images/cover.jpg");
  });

  it("resolves relative href from base dir", function () {
    expect(resolveRelative("OPS/Text", "../Images/cover.jpg")).toBe("OPS/Images/cover.jpg");
    expect(resolveRelative("", "/OPS/Text/ch1.xhtml")).toBe("OPS/Text/ch1.xhtml");
  });

  it("parses internal and external refs", function () {
    expect(resolveTargetRef("OPS", "Text/ch1.xhtml#sec%201")).toEqual({
      external: false,
      path: "OPS/Text/ch1.xhtml",
      fragment: "sec 1"
    });

    expect(resolveTargetRef("OPS", "https://example.com/ch1")).toEqual({
      external: true,
      path: "https://example.com/ch1",
      fragment: ""
    });
  });

  it("extracts dirname after normalization", function () {
    expect(dirname("OPS/Text/chapter1.xhtml")).toBe("OPS/Text");
    expect(dirname("chapter1.xhtml")).toBe("");
  });
});
