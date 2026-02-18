import { describe, expect, it } from "vitest";
import { locateOpfPath, parseContainerInfo } from "../../src/epub/parser.js";

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
    findFirst(regex) {
      var matched = "";
      files.forEach(function (_value, key) {
        if (!matched && regex.test(key)) {
          matched = key;
        }
      });
      return matched;
    }
  };
}

describe("container parsing", function () {
  it("parses rootfiles and picks OPF rootfile first", async function () {
    var resolver = createTextResolver({
      "META-INF/container.xml": "" +
        "<?xml version='1.0' encoding='utf-8'?>" +
        "<container version='1.0' xmlns='urn:oasis:names:tc:opendocument:xmlns:container'>" +
        "  <rootfiles>" +
        "    <rootfile full-path='OPS/main.opf' media-type='application/oebps-package+xml'/>" +
        "    <rootfile full-path='OPS/alt.opf' media-type='application/oebps-package+xml'/>" +
        "  </rootfiles>" +
        "</container>",
      "OPS/main.opf": "<package/>",
      "OPS/alt.opf": "<package/>"
    });

    var container = await parseContainerInfo(resolver);
    expect(container.rootfiles).toHaveLength(2);

    var opfPath = await locateOpfPath(resolver, { containerInfo: container });
    expect(opfPath).toBe("OPS/main.opf");
  });

  it("falls back to scanning .opf when container.xml is missing", async function () {
    var resolver = createTextResolver({
      "book/content.opf": "<package/>"
    });

    var container = await parseContainerInfo(resolver);
    expect(container.warnings.length).toBeGreaterThan(0);

    var opfPath = await locateOpfPath(resolver, { containerInfo: container });
    expect(opfPath).toBe("book/content.opf");
  });
});
