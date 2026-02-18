import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createMediaAssetRegistry,
  loadSpineChapters,
  locateOpfPath,
  parseOpf,
  parseToc,
  parseXml
} from "../../src/epub/parser.js";
import { removeDuplicateLeadingHeading } from "../../src/epub/chapter-title.js";

var BOOK_ROOT = path.resolve(process.cwd(), "book/the four steps to the epiphany");

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

describe("four steps heading dedupe", function () {
  var chapters = [];

  beforeAll(async function () {
    var fixtureFiles = await listFilesRecursively(BOOK_ROOT, "");
    var resolver = createFsResolver(BOOK_ROOT, fixtureFiles);

    var locatedOpfPath = await locateOpfPath(resolver);
    var opfText = await resolver.readText(locatedOpfPath);
    var opfInfo = parseOpf(parseXml(opfText));
    var tocData = await parseToc(resolver, opfInfo, dirname(locatedOpfPath));

    var mediaRegistry = createMediaAssetRegistry();
    chapters = await loadSpineChapters(resolver, opfInfo, dirname(locatedOpfPath), tocData, {
      onChapterStatus: function () {},
      mediaAssetRegistry: mediaRegistry
    });
    mediaRegistry.revokeAll();
  }, 120000);

  it("dedupes chapter marker + subtitle when toc title already contains both", function () {
    var chapter1 = null;
    for (var i = 0; i < chapters.length; i += 1) {
      if (chapters[i].path === "OEBPS/7-chap1.xhtml") {
        chapter1 = chapters[i];
        break;
      }
    }

    expect(chapter1).not.toBeNull();
    expect(chapter1.title).toBe("Chapter 1: The Path To Disaster: The Product Development Model");

    var dedupedHtml = removeDuplicateLeadingHeading(chapter1.html, chapter1.title);
    var parser = new DOMParser();
    var doc = parser.parseFromString("<!doctype html><html><body>" + dedupedHtml + "</body></html>", "text/html");
    var body = doc.body;

    expect(body.querySelector("h1.chapter")).toBeNull();
    expect(body.querySelector("h1.chapter2")).toBeNull();
    expect(body.firstElementChild && body.firstElementChild.classList.contains("blockquote")).toBe(true);
  });

  it("for chapter 5, keeps the leading image block and removes duplicated chapter headings", function () {
    var chapter5 = null;
    for (var i = 0; i < chapters.length; i += 1) {
      if (chapters[i].path === "OEBPS/16-chap5.xhtml") {
        chapter5 = chapters[i];
        break;
      }
    }

    expect(chapter5).not.toBeNull();
    expect(chapter5.title).toBe("Chapter 5: Customer Creation");

    var dedupedHtml = removeDuplicateLeadingHeading(chapter5.html, chapter5.title);
    var parser = new DOMParser();
    var doc = parser.parseFromString("<!doctype html><html><body>" + dedupedHtml + "</body></html>", "text/html");
    var body = doc.body;

    expect(body.querySelector("p#ch16__chap5__0 img")).not.toBeNull();
    expect(body.querySelector("h1.chapter")).toBeNull();
    expect(body.querySelector("h1.chapter2")).toBeNull();
    expect(body.firstElementChild && body.firstElementChild.id).toBe("ch16__chap5__0");
  });
});
