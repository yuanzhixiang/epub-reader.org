import { describe, expect, it } from "vitest";
import { parseEncryptionInfo } from "../../src/epub/parser.js";

function createTextResolver(fileMap) {
  var files = new Map(Object.entries(fileMap));
  return {
    resolve(path) {
      return files.has(path) ? path : "";
    },
    async readText(path) {
      if (!files.has(path)) {
        throw new Error("File not found: " + path);
      }
      return files.get(path);
    }
  };
}

describe("parseEncryptionInfo", function () {
  it("parses encrypted resources and algorithm support", async function () {
    var resolver = createTextResolver({
      "META-INF/encryption.xml": "" +
        "<encryption xmlns='urn:oasis:names:tc:opendocument:xmlns:container'" +
        " xmlns:enc='http://www.w3.org/2001/04/xmlenc#'>" +
        "  <enc:EncryptedData>" +
        "    <enc:EncryptionMethod Algorithm='http://ns.adobe.com/pdf/enc#RC'/>" +
        "    <enc:CipherData><enc:CipherReference URI='fonts/a.ttf'/></enc:CipherData>" +
        "  </enc:EncryptedData>" +
        "  <enc:EncryptedData>" +
        "    <enc:EncryptionMethod Algorithm='urn:custom:drm'/>" +
        "    <enc:CipherData><enc:CipherReference URI='/text/ch1.xhtml'/></enc:CipherData>" +
        "  </enc:EncryptedData>" +
        "</encryption>"
    });

    var info = await parseEncryptionInfo(resolver);

    expect(info.path).toBe("META-INF/encryption.xml");
    expect(info.resources).toHaveLength(2);
    expect(info.byPath.get("fonts/a.ttf")).toMatchObject({
      algorithm: "http://ns.adobe.com/pdf/enc#RC",
      supported: true
    });
    expect(info.byPath.get("text/ch1.xhtml")).toMatchObject({
      algorithm: "urn:custom:drm",
      supported: false
    });
  });

  it("returns empty result when encryption.xml is absent", async function () {
    var info = await parseEncryptionInfo(createTextResolver({}));
    expect(info).toMatchObject({
      path: "",
      resources: []
    });
    expect(info.byPath.size).toBe(0);
  });
});
