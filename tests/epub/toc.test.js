import { describe, expect, it } from "vitest";
import { normalizePath, parseToc } from "../../src/epub/parser.js";

function createTextResolver(fileMap) {
  var files = new Map();
  Object.keys(fileMap).forEach(function (path) {
    files.set(normalizePath(path), fileMap[path]);
  });

  return {
    has(path) {
      return files.has(normalizePath(path));
    },
    async readText(path) {
      var key = normalizePath(path);
      if (!files.has(key)) {
        throw new Error("File not found: " + path);
      }
      return files.get(key);
    }
  };
}

describe("parseToc", function () {
  it("prefers NCX when spine toc id points to a valid file", async function () {
    var resolver = createTextResolver({
      "OPS/toc.ncx": "" +
        "<?xml version='1.0' encoding='utf-8'?>" +
        "<ncx xmlns='http://www.daisy.org/z3986/2005/ncx/'>" +
        "  <navMap>" +
        "    <navPoint id='navPoint-1'>" +
        "      <navLabel><text>Chapter One</text></navLabel>" +
        "      <content src='Text/ch1.xhtml' />" +
        "    </navPoint>" +
        "  </navMap>" +
        "</ncx>"
    });

    var opfInfo = {
      manifest: new Map([
        ["ncx", { href: "toc.ncx", properties: "", mediaType: "application/x-dtbncx+xml" }]
      ]),
      spineTocId: "ncx"
    };

    var toc = await parseToc(resolver, opfInfo, "OPS");
    expect(toc.source).toBe("ncx");
    expect(toc.baseDir).toBe("OPS");
    expect(toc.items[0]).toMatchObject({ title: "Chapter One", href: "Text/ch1.xhtml" });
  });

  it("falls back to EPUB3 nav when NCX is unavailable", async function () {
    var resolver = createTextResolver({
      "OPS/nav.xhtml": "" +
        "<html xmlns='http://www.w3.org/1999/xhtml' xmlns:epub='http://www.idpf.org/2007/ops'>" +
        "  <body>" +
        "    <nav epub:type='toc'>" +
        "      <ol><li><a href='Text/ch1.xhtml'>Nav Chapter</a></li></ol>" +
        "    </nav>" +
        "  </body>" +
        "</html>"
    });

    var opfInfo = {
      manifest: new Map([
        ["nav", { href: "nav.xhtml", properties: "nav", mediaType: "application/xhtml+xml" }]
      ]),
      spineTocId: ""
    };

    var toc = await parseToc(resolver, opfInfo, "OPS");
    expect(toc.source).toBe("nav");
    expect(toc.baseDir).toBe("OPS");
    expect(toc.items[0]).toMatchObject({ title: "Nav Chapter", href: "Text/ch1.xhtml" });
  });

  it("returns spine fallback marker when neither NCX nor nav exists", async function () {
    var resolver = createTextResolver({});
    var opfInfo = {
      manifest: new Map(),
      spineTocId: ""
    };

    var toc = await parseToc(resolver, opfInfo, "OPS");
    expect(toc).toEqual({
      source: "spine-fallback",
      baseDir: "OPS",
      items: []
    });
  });
});
