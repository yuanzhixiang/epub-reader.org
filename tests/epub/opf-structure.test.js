import { describe, expect, it } from "vitest";
import { parseOpf, parseXml } from "../../src/epub/parser.js";

function createTextResolver(fileMap) {
  var files = new Map(Object.entries(fileMap));
  return {
    has(path) {
      return files.has(path);
    },
    resolve(path) {
      return files.has(path) ? path : "";
    }
  };
}

describe("parseOpf structure", function () {
  it("extracts metadata, cover, guide and spine linearity", function () {
    var opfXml = "" +
      "<?xml version='1.0' encoding='utf-8'?>" +
      "<package xmlns='http://www.idpf.org/2007/opf' version='3.0' unique-identifier='book-id'>" +
      "  <metadata xmlns:dc='http://purl.org/dc/elements/1.1/'>" +
      "    <dc:identifier id='book-id'>urn:uuid:test-book</dc:identifier>" +
      "    <dc:title>Structure Book</dc:title>" +
      "    <dc:language>en</dc:language>" +
      "    <meta name='cover' content='cover-img'/>" +
      "    <meta property='dcterms:modified'>2024-01-01T00:00:00Z</meta>" +
      "  </metadata>" +
      "  <manifest>" +
      "    <item id='nav' href='nav.xhtml' media-type='application/xhtml+xml' properties='nav'/>" +
      "    <item id='cover-img' href='images/cover.jpg' media-type='image/jpeg'/>" +
      "    <item id='ch1' href='text/ch1.xhtml' media-type='application/xhtml+xml'/>" +
      "    <item id='ch2' href='text/ch2.xhtml' media-type='application/xhtml+xml'/>" +
      "  </manifest>" +
      "  <spine page-progression-direction='rtl'>" +
      "    <itemref idref='ch1'/>" +
      "    <itemref idref='ch2' linear='no'/>" +
      "  </spine>" +
      "  <guide><reference type='cover' href='text/ch1.xhtml' title='Cover Page'/></guide>" +
      "</package>";

    var resolver = createTextResolver({
      "OPS/nav.xhtml": "",
      "OPS/images/cover.jpg": "",
      "OPS/text/ch1.xhtml": "",
      "OPS/text/ch2.xhtml": ""
    });

    var opf = parseOpf(parseXml(opfXml), { opfDir: "OPS", resolver: resolver });

    expect(opf.primaryIdentifier).toBe("urn:uuid:test-book");
    expect(opf.metadata.dc.language).toEqual(["en"]);
    expect(opf.metadata.metaProperties[0]).toMatchObject({ property: "dcterms:modified" });
    expect(opf.cover).toMatchObject({
      id: "cover-img",
      path: "OPS/images/cover.jpg",
      source: "meta-name-cover"
    });
    expect(opf.nav).toMatchObject({ id: "nav", path: "OPS/nav.xhtml" });
    expect(opf.pageProgressionDirection).toBe("rtl");
    expect(opf.linearReadingOrder.map(function (item) { return item.idref; })).toEqual(["ch1"]);
    expect(opf.nonLinearItems.map(function (item) { return item.idref; })).toEqual(["ch2"]);
    expect(opf.resolvedReadingOrder.map(function (item) { return item.status; })).toEqual(["ok", "ok"]);
    expect(opf.guide.references[0]).toMatchObject({ type: "cover", path: "OPS/text/ch1.xhtml" });
  });

  it("marks out-of-container spine target in resolved reading order", function () {
    var opfXml = "" +
      "<?xml version='1.0' encoding='utf-8'?>" +
      "<package xmlns='http://www.idpf.org/2007/opf' version='2.0'>" +
      "  <manifest>" +
      "    <item id='ch1' href='../../outside.xhtml' media-type='application/xhtml+xml'/>" +
      "  </manifest>" +
      "  <spine><itemref idref='ch1'/></spine>" +
      "</package>";

    var opf = parseOpf(parseXml(opfXml), { opfDir: "OPS", resolver: createTextResolver({}) });
    expect(opf.manifest.get("ch1").outOfContainer).toBe(true);
    expect(opf.resolvedReadingOrder[0].status).toBe("out-of-container");
  });
});
