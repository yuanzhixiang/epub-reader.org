import { describe, expect, it } from "vitest";
import { loadSpineChapters, parseOpf, parseXml } from "../../src/epub/parser.js";

function createTextResolver(fileMap) {
  var files = new Map(Object.entries(fileMap));

  return {
    resolve(path) {
      return files.has(path) ? path : "";
    },
    has(path) {
      return files.has(path);
    },
    async readText(path) {
      if (!files.has(path)) {
        throw new Error("File not found: " + path);
      }
      return files.get(path);
    },
    async readBinary(path) {
      if (!files.has(path)) {
        throw new Error("File not found: " + path);
      }
      return new Uint8Array(Buffer.from(String(files.get(path))));
    }
  };
}

describe("manifest fallback chain", function () {
  it("uses fallback html when spine item points to non-html resource", async function () {
    var opfXml = "" +
      "<?xml version='1.0' encoding='utf-8'?>" +
      "<package xmlns='http://www.idpf.org/2007/opf' version='2.0'>" +
      "  <metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Fallback Book</dc:title></metadata>" +
      "  <manifest>" +
      "    <item id='img-spine' href='images/cover.jpg' media-type='image/jpeg' fallback='ch1' />" +
      "    <item id='ch1' href='text/ch1.xhtml' media-type='application/xhtml+xml' />" +
      "  </manifest>" +
      "  <spine>" +
      "    <itemref idref='img-spine' />" +
      "  </spine>" +
      "</package>";

    var resolver = createTextResolver({
      "OPS/images/cover.jpg": "not-used",
      "OPS/text/ch1.xhtml": "<html><body><h1>Chapter One</h1><p>Hello fallback chain.</p></body></html>"
    });

    var opfInfo = parseOpf(parseXml(opfXml), { opfDir: "OPS", resolver: resolver });
    var audit = { spineItems: [] };

    var chapters = await loadSpineChapters(resolver, opfInfo, "OPS", { items: [], baseDir: "OPS" }, {
      onChapterStatus: function () {},
      mediaAssetRegistry: { getOrCreate: async function () { return ""; } },
      auditCollector: audit
    });

    expect(chapters).toHaveLength(1);
    expect(chapters[0].path).toBe("OPS/text/ch1.xhtml");
    expect(chapters[0].sourceIdref).toBe("img-spine");
    expect(audit.spineItems[0].status).toBe("rendered");
    expect(audit.spineItems[0].fallbackChain.length).toBeGreaterThan(1);
  });

  it("marks out-of-container spine href as unresolved", async function () {
    var opfXml = "" +
      "<?xml version='1.0' encoding='utf-8'?>" +
      "<package xmlns='http://www.idpf.org/2007/opf' version='2.0'>" +
      "  <manifest>" +
      "    <item id='bad' href='../../outside.xhtml' media-type='application/xhtml+xml' />" +
      "  </manifest>" +
      "  <spine><itemref idref='bad' /></spine>" +
      "</package>";

    var resolver = createTextResolver({});
    var opfInfo = parseOpf(parseXml(opfXml), { opfDir: "OPS", resolver: resolver });
    var audit = { spineItems: [] };

    var chapters = await loadSpineChapters(resolver, opfInfo, "OPS", { items: [], baseDir: "OPS" }, {
      onChapterStatus: function () {},
      mediaAssetRegistry: { getOrCreate: async function () { return ""; } },
      auditCollector: audit
    });

    expect(chapters).toEqual([]);
    expect(audit.spineItems[0].status).toBe("out-of-container");
  });
});
