import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

var BOOK_ROOT = path.resolve(process.cwd(), "book/lean analytics");
var mockParsedBook = null;

vi.mock("../../src/epub/parser.js", async function () {
  var actual = await vi.importActual("../../src/epub/parser.js");
  return {
    ...actual,
    parseEpubFromArrayBuffer: async function () {
      if (!mockParsedBook) {
        throw new Error("lean analytics mock payload is not ready");
      }
      return mockParsedBook;
    }
  };
});

import {
  createMediaAssetRegistry,
  loadSpineChapters,
  locateOpfPath,
  parseOpf,
  parseToc,
  parseXml
} from "../../src/epub/parser.js";

function normalizePath(input) {
  var value = String(input || "").replace(/\\/g, "/");
  var parts = value.split("/");
  var out = [];
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i];
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

async function listFilesRecursively(rootDir, subDir) {
  var base = subDir ? path.join(rootDir, subDir) : rootDir;
  var entries = await fs.readdir(base, { withFileTypes: true });
  var out = [];

  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    if (entry.name === ".DS_Store") {
      continue;
    }

    var relPath = subDir ? path.join(subDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      var nested = await listFilesRecursively(rootDir, relPath);
      for (var j = 0; j < nested.length; j += 1) {
        out.push(nested[j]);
      }
      continue;
    }
    out.push(normalizePath(relPath));
  }

  return out;
}

function dirname(filePath) {
  var norm = normalizePath(filePath);
  var index = norm.lastIndexOf("/");
  return index < 0 ? "" : norm.slice(0, index);
}

function createFsResolver(rootDir, filePaths) {
  var exact = new Map();
  var lower = new Map();

  for (var i = 0; i < filePaths.length; i += 1) {
    var relPath = normalizePath(filePaths[i]);
    exact.set(relPath, relPath);
    lower.set(relPath.toLowerCase(), relPath);
  }

  function resolve(pathValue) {
    var norm = normalizePath(pathValue);
    return exact.get(norm) || lower.get(norm.toLowerCase()) || "";
  }

  return {
    findFirst: function (regex) {
      var found = "";
      exact.forEach(function (_value, key) {
        if (!found && regex.test(key)) {
          found = key;
        }
      });
      return found;
    },
    resolve: resolve,
    has: function (pathValue) {
      return !!resolve(pathValue);
    },
    readText: async function (pathValue) {
      var rel = resolve(pathValue);
      if (!rel) {
        throw new Error("File not found: " + pathValue);
      }
      return fs.readFile(path.join(rootDir, rel), "utf8");
    },
    readBinary: async function (pathValue) {
      var rel = resolve(pathValue);
      if (!rel) {
        throw new Error("File not found: " + pathValue);
      }
      var buffer = await fs.readFile(path.join(rootDir, rel));
      return new Uint8Array(buffer);
    }
  };
}

function waitFor(check, timeoutMs) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    function loop() {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(loop, 10);
    }
    loop();
  });
}

function findTocLinkByText(label) {
  var links = document.querySelectorAll("#tocWrap a");
  for (var i = 0; i < links.length; i += 1) {
    if (String(links[i].textContent || "").trim() === label) {
      return links[i];
    }
  }
  return null;
}

describe("lean analytics toc anchor jump", function () {
  var expectedMappedAnchorId = "";
  var scrollHits = [];
  var savedScrollIntoView = null;

  beforeAll(async function () {
    var files = await listFilesRecursively(BOOK_ROOT, "");
    var resolver = createFsResolver(BOOK_ROOT, files);

    var opfPath = await locateOpfPath(resolver);
    var opfInfo = parseOpf(parseXml(await resolver.readText(opfPath)));
    var tocData = await parseToc(resolver, opfInfo, dirname(opfPath));

    var mediaRegistry = createMediaAssetRegistry();
    var chapters = await loadSpineChapters(resolver, opfInfo, dirname(opfPath), tocData, {
      onChapterStatus: function () {},
      mediaAssetRegistry: mediaRegistry
    });
    mediaRegistry.revokeAll();

    mockParsedBook = {
      title: "Lean Analytics",
      tocData: tocData,
      chapters: chapters
    };

    var prefaceChapter = null;
    for (var i = 0; i < chapters.length; i += 1) {
      if (chapters[i].path === "OEBPS/pr05.html") {
        prefaceChapter = chapters[i];
        break;
      }
    }

    expect(prefaceChapter).not.toBeNull();
    expectedMappedAnchorId = prefaceChapter.idMap.get("building_blocks") || "";
    expect(expectedMappedAnchorId).not.toBe("");

    document.body.innerHTML = "" +
      "<input id=\"fileInput\" type=\"file\" />" +
      "<div id=\"dropZone\"></div>" +
      "<div id=\"startScreen\"></div>" +
      "<div id=\"viewerLayout\" hidden>" +
      "  <div id=\"tocWrap\"></div>" +
      "  <div id=\"mainPanel\"><div id=\"contentBody\"></div></div>" +
      "</div>" +
      "<div id=\"statusInline\"></div>";

    savedScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      scrollHits.push(this.id || "");
    };

    window.JSZip = function () {};

    await import("../../src/main.js");

    var fileInput = document.getElementById("fileInput");
    var fakeFile = {
      name: "lean-analytics.epub",
      arrayBuffer: async function () {
        return new ArrayBuffer(16);
      }
    };
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [fakeFile]
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(function () {
      return !!findTocLinkByText("The Building Blocks");
    }, 5000);
  }, 120000);

  afterAll(function () {
    if (savedScrollIntoView) {
      Element.prototype.scrollIntoView = savedScrollIntoView;
    } else {
      delete Element.prototype.scrollIntoView;
    }
    delete window.JSZip;
  });

  it("clicking 'The Building Blocks' scrolls to the mapped preface anchor", async function () {
    scrollHits = [];
    var buildingBlocksLink = findTocLinkByText("The Building Blocks");
    expect(buildingBlocksLink).not.toBeNull();

    buildingBlocksLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await waitFor(function () {
      for (var i = 0; i < scrollHits.length; i += 1) {
        if (scrollHits[i] === expectedMappedAnchorId) {
          return true;
        }
      }
      return false;
    }, 5000);

    expect(document.getElementById(expectedMappedAnchorId)).not.toBeNull();
    expect(scrollHits).toContain(expectedMappedAnchorId);
  });

});
