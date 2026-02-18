import { describe, expect, it } from "vitest";
import { parseOpf, parseXml } from "../../src/epub/parser.js";

describe("parseOpf", function () {
  it("extracts title, manifest, spine and toc id", function () {
    var xml = "" +
      "<?xml version='1.0' encoding='utf-8'?>" +
      "<package xmlns='http://www.idpf.org/2007/opf' version='2.0' unique-identifier='BookId'>" +
      "  <metadata xmlns:dc='http://purl.org/dc/elements/1.1/'>" +
      "    <dc:title>Sample Book</dc:title>" +
      "  </metadata>" +
      "  <manifest>" +
      "    <item id='ncx' href='toc.ncx' media-type='application/x-dtbncx+xml' />" +
      "    <item id='chap1' href='Text/ch1.xhtml' media-type='application/xhtml+xml' />" +
      "  </manifest>" +
      "  <spine toc='ncx'>" +
      "    <itemref idref='chap1' />" +
      "  </spine>" +
      "</package>";

    var opf = parseOpf(parseXml(xml));

    expect(opf.title).toBe("Sample Book");
    expect(opf.spineTocId).toBe("ncx");
    expect(opf.spine).toEqual(["chap1"]);
    expect(opf.manifest.get("chap1")).toMatchObject({
      href: "Text/ch1.xhtml",
      mediaType: "application/xhtml+xml"
    });
  });
});
