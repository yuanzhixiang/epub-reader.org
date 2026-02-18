import { describe, expect, it } from "vitest";
import { createMediaAssetRegistry, loadSpineChapters, parseOpf, parseXml } from "../../src/epub/parser.js";

function createResolver(fileMap) {
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

describe("resource audit collection", function () {
  it("collects resolved, missing and blocked resource references from chapter content", async function () {
    var opfXml = "" +
      "<?xml version='1.0' encoding='utf-8'?>" +
      "<package xmlns='http://www.idpf.org/2007/opf' version='2.0'>" +
      "  <manifest>" +
      "    <item id='ch1' href='text/ch1.xhtml' media-type='application/xhtml+xml' />" +
      "    <item id='img1' href='images/ok.jpg' media-type='image/jpeg' />" +
      "  </manifest>" +
      "  <spine><itemref idref='ch1' /></spine>" +
      "</package>";

    var chapterHtml = "" +
      "<html><body>" +
      "  <img src='../images/ok.jpg'/>" +
      "  <img src='../images/missing.jpg'/>" +
      "  <img src='../../../outside.jpg'/>" +
      "  <img src='http://example.com/remote.jpg'/>" +
      "  <img src='file:///tmp/local.jpg'/>" +
      "</body></html>";

    var resolver = createResolver({
      "OPS/text/ch1.xhtml": chapterHtml,
      "OPS/images/ok.jpg": "ok-image"
    });

    var opf = parseOpf(parseXml(opfXml), { opfDir: "OPS", resolver: resolver });
    var audit = { spineItems: [], referencedResources: [] };

    var originalCreateObjectURL = URL.createObjectURL;
    var originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = function () {
      return "blob:test-resource";
    };
    URL.revokeObjectURL = function () {};

    var mediaRegistry = createMediaAssetRegistry();
    try {
      var chapters = await loadSpineChapters(resolver, opf, "OPS", { items: [], baseDir: "OPS" }, {
        onChapterStatus: function () {},
        mediaAssetRegistry: mediaRegistry,
        auditCollector: audit
      });

      expect(chapters).toHaveLength(1);
      var statuses = audit.referencedResources.map(function (item) {
        return item.status;
      });
      expect(statuses).toContain("resolved");
      expect(statuses).toContain("missing-resource");
      expect(statuses).toContain("out-of-container");
      expect(statuses).toContain("remote-resource");
      expect(statuses).toContain("blocked-file-scheme");
    } finally {
      mediaRegistry.revokeAll();
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
