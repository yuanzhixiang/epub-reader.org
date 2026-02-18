import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMediaAssetRegistry,
  loadSpineChapters,
  locateOpfPath,
  parseOpf,
  parseToc,
  parseXml,
  resolveRelative
} from "../../src/epub/parser.js";

var BOOK_ROOT = path.resolve(process.cwd(), "book/the lean startup");

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

function dirname(filePath) {
  var norm = normalizePath(filePath);
  var index = norm.lastIndexOf("/");
  return index < 0 ? "" : norm.slice(0, index);
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function localName(node) {
  return (node && (node.localName || node.nodeName) || "").toLowerCase().replace(/^.*:/, "");
}

function isHtmlMedia(pathValue, mediaType) {
  var lowerType = String(mediaType || "").toLowerCase();
  return lowerType.indexOf("xhtml") >= 0 || lowerType.indexOf("html") >= 0 || /\.x?html?$/i.test(pathValue);
}

function getTextFromHtmlFragment(fragmentHtml) {
  var parser = new DOMParser();
  var doc = parser.parseFromString("<!doctype html><html><body>" + String(fragmentHtml || "") + "</body></html>", "text/html");
  return cleanText(doc.body ? (doc.body.textContent || "") : "");
}

function pickSnippet(fullText) {
  var normalized = cleanText(fullText);
  if (!normalized) {
    return "";
  }

  var segments = normalized.split(/[。！？.!?]/);
  for (var i = 0; i < segments.length; i += 1) {
    var candidate = cleanText(segments[i]);
    if (candidate.length >= 18) {
      return candidate.slice(0, 80);
    }
  }

  return normalized.slice(0, 80);
}

function buildVerificationProbe(sourceRaw) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(String(sourceRaw || ""), "text/html");
  var body = doc.body;
  if (!body) {
    return null;
  }

  var bodyText = cleanText(body.textContent || "");
  var textSnippet = pickSnippet(bodyText);
  if (textSnippet) {
    return { type: "text", value: textSnippet };
  }

  var altNodes = body.querySelectorAll("[alt]");
  for (var i = 0; i < altNodes.length; i += 1) {
    var altValue = pickSnippet(altNodes[i].getAttribute("alt") || "");
    if (altValue) {
      return { type: "alt", value: altValue };
    }
  }

  var mediaTags = ["img", "svg", "image", "video", "audio", "source"];
  for (var j = 0; j < mediaTags.length; j += 1) {
    if (body.querySelector(mediaTags[j])) {
      return { type: "media-tag", value: mediaTags[j] };
    }
  }

  return null;
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
      var abs = path.join(rootDir, rel);
      return fs.readFile(abs, "utf8");
    },
    readBinary: async function (pathValue) {
      var rel = resolve(pathValue);
      if (!rel) {
        throw new Error("File not found: " + pathValue);
      }
      var abs = path.join(rootDir, rel);
      var buffer = await fs.readFile(abs);
      return new Uint8Array(buffer);
    }
  };
}

async function readPackageModel(rootDir) {
  var containerXml = await fs.readFile(path.join(rootDir, "META-INF/container.xml"), "utf8");
  var containerDoc = parseXml(containerXml);
  var rootfiles = containerDoc.getElementsByTagNameNS("*", "rootfile");

  var opfPath = "";
  for (var i = 0; i < rootfiles.length; i += 1) {
    var fullPath = rootfiles[i].getAttribute("full-path") || "";
    if (fullPath) {
      opfPath = normalizePath(fullPath);
      break;
    }
  }

  if (!opfPath) {
    throw new Error("Cannot locate OPF path from fixture container.xml");
  }

  var opfRaw = await fs.readFile(path.join(rootDir, opfPath), "utf8");
  var opfDoc = parseXml(opfRaw);

  var manifestById = new Map();
  var itemNodes = opfDoc.getElementsByTagNameNS("*", "item");
  for (var j = 0; j < itemNodes.length; j += 1) {
    if (!itemNodes[j].parentNode || localName(itemNodes[j].parentNode) !== "manifest") {
      continue;
    }
    var id = itemNodes[j].getAttribute("id") || "";
    var href = itemNodes[j].getAttribute("href") || "";
    if (!id || !href) {
      continue;
    }
    manifestById.set(id, {
      id: id,
      href: href,
      mediaType: itemNodes[j].getAttribute("media-type") || ""
    });
  }

  var spineIdrefs = [];
  var itemRefNodes = opfDoc.getElementsByTagNameNS("*", "itemref");
  for (var k = 0; k < itemRefNodes.length; k += 1) {
    if (!itemRefNodes[k].parentNode || localName(itemRefNodes[k].parentNode) !== "spine") {
      continue;
    }
    var idref = itemRefNodes[k].getAttribute("idref") || "";
    if (idref) {
      spineIdrefs.push(idref);
    }
  }

  return {
    opfPath: opfPath,
    opfDir: dirname(opfPath),
    manifestById: manifestById,
    spineIdrefs: spineIdrefs
  };
}

describe("lean startup post-unzip parsing", function () {
  var fixtureFiles = [];
  var fixtureFileSet = new Set();
  var resolver = null;
  var packageModel = null;
  var opfInfo = null;
  var tocData = null;
  var chapters = [];
  var savedCreateObjectURL = null;
  var savedRevokeObjectURL = null;
  var objectUrlSeq = 0;

  beforeAll(async function () {
    savedCreateObjectURL = URL.createObjectURL;
    savedRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = function () {
      objectUrlSeq += 1;
      return "blob:test-cover-" + objectUrlSeq;
    };
    URL.revokeObjectURL = function () {};

    fixtureFiles = await listFilesRecursively(BOOK_ROOT, "");
    fixtureFileSet = new Set(fixtureFiles);
    resolver = createFsResolver(BOOK_ROOT, fixtureFiles);

    var locatedOpfPath = await locateOpfPath(resolver);
    var opfText = await resolver.readText(locatedOpfPath);
    opfInfo = parseOpf(parseXml(opfText));
    tocData = await parseToc(resolver, opfInfo, dirname(locatedOpfPath));

    var mediaRegistry = createMediaAssetRegistry();
    chapters = await loadSpineChapters(resolver, opfInfo, dirname(locatedOpfPath), tocData, {
      onChapterStatus: function () {},
      mediaAssetRegistry: mediaRegistry
    });
    mediaRegistry.revokeAll();

    packageModel = await readPackageModel(BOOK_ROOT);
  }, 120000);

  afterAll(function () {
    if (savedCreateObjectURL) {
      URL.createObjectURL = savedCreateObjectURL;
    } else {
      delete URL.createObjectURL;
    }
    if (savedRevokeObjectURL) {
      URL.revokeObjectURL = savedRevokeObjectURL;
    } else {
      delete URL.revokeObjectURL;
    }
  });

  it("reads OPF and resolves expected metadata", function () {
    expect(fixtureFiles.length).toBeGreaterThan(100);
    expect(packageModel.opfPath).toBe("content.opf");
    expect(opfInfo.title).toBe("The Lean Startup");
    expect(tocData.source).toBe("ncx");
  });

  it("parses every spine html/xhtml file without drop or reorder", function () {
    var expectedPaths = [];

    for (var i = 0; i < packageModel.spineIdrefs.length; i += 1) {
      var idref = packageModel.spineIdrefs[i];
      var manifestItem = packageModel.manifestById.get(idref);
      if (!manifestItem) {
        continue;
      }

      var resolvedPath = resolveRelative(packageModel.opfDir, manifestItem.href);
      if (!isHtmlMedia(resolvedPath, manifestItem.mediaType)) {
        continue;
      }
      if (!fixtureFileSet.has(resolvedPath)) {
        continue;
      }

      expectedPaths.push(resolvedPath);
    }

    var actualPaths = chapters.map(function (chapter) {
      return chapter.path;
    });

    expect(actualPaths).toEqual(expectedPaths);
  });

  it("rewrites titlepage svg cover href to blob URL", function () {
    var titlepageChapter = null;
    for (var i = 0; i < chapters.length; i += 1) {
      if (chapters[i].path === "titlepage.xhtml") {
        titlepageChapter = chapters[i];
        break;
      }
    }

    expect(titlepageChapter).not.toBeNull();
    var html = String(titlepageChapter ? titlepageChapter.html : "");
    var hasBlobHref = /<image\b[^>]*(?:xlink:href|href)=["']blob:/i.test(html);
    expect(hasBlobHref).toBe(true);
  });

  it("for each parsed chapter file, a sampled source snippet is present in parsed output", async function () {
    var chapterByPath = new Map();
    for (var i = 0; i < chapters.length; i += 1) {
      chapterByPath.set(chapters[i].path, chapters[i]);
    }

    var filesWithoutProbe = [];
    var filesMissingProbe = [];

    for (var j = 0; j < chapters.length; j += 1) {
      var chapterPath = chapters[j].path;
      var sourceRaw = await resolver.readText(chapterPath);
      var probe = buildVerificationProbe(sourceRaw);

      if (!probe) {
        filesWithoutProbe.push(chapterPath);
        continue;
      }

      var parsedChapter = chapterByPath.get(chapterPath);
      var parsedHtml = String(parsedChapter ? parsedChapter.html : "");
      var parsedText = getTextFromHtmlFragment(parsedChapter ? parsedChapter.html : "");
      if (probe.type === "media-tag") {
        var tagRegex = new RegExp("<" + probe.value + "\\b", "i");
        if (!tagRegex.test(parsedHtml)) {
          filesMissingProbe.push({
            path: chapterPath,
            probe: probe
          });
        }
        continue;
      }

      if (probe.type === "alt") {
        if (parsedHtml.indexOf(probe.value) < 0) {
          filesMissingProbe.push({
            path: chapterPath,
            probe: probe
          });
        }
        continue;
      }

      if (parsedText.indexOf(probe.value) < 0) {
        filesMissingProbe.push({
          path: chapterPath,
          probe: probe
        });
      }
    }

    expect(filesWithoutProbe).toEqual([]);
    expect(filesMissingProbe).toEqual([]);
  });
});
