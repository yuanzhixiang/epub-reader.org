export function createMediaAssetRegistry() {
  var mediaAssetUrlCache = new Map();
  var mediaAssetObjectUrls = [];

  return {
    get size() {
      return mediaAssetUrlCache.size;
    },

    async getOrCreate(resolver, path, mediaTypeByPath) {
      var normPath = normalizePath(path);
      if (mediaAssetUrlCache.has(normPath)) {
        return mediaAssetUrlCache.get(normPath);
      }

      try {
        var bytes = await resolver.readBinary(normPath);
        var mediaType = (mediaTypeByPath && mediaTypeByPath.get(normPath)) || guessMediaType(normPath);
        var blob = new Blob([bytes], { type: mediaType || "application/octet-stream" });
        var objectUrl = URL.createObjectURL(blob);
        mediaAssetUrlCache.set(normPath, objectUrl);
        mediaAssetObjectUrls.push(objectUrl);
        return objectUrl;
      } catch (_error) {
        return "";
      }
    },

    revokeAll() {
      for (var i = 0; i < mediaAssetObjectUrls.length; i += 1) {
        try {
          URL.revokeObjectURL(mediaAssetObjectUrls[i]);
        } catch (_error) {
          // Ignore revoke failures for stale object URLs.
        }
      }
      mediaAssetObjectUrls = [];
      mediaAssetUrlCache.clear();
    }
  };
}

export async function parseEpubFromArrayBuffer(arrayBuffer, options) {
  var opts = options || {};
  var jszip = opts.jszip;
  var onStatus = typeof opts.onStatus === "function" ? opts.onStatus : function () {};
  var mediaAssetRegistry = opts.mediaAssetRegistry || createMediaAssetRegistry();

  if (!jszip || typeof jszip.loadAsync !== "function") {
    throw new Error("JSZip is required to parse EPUB archives.");
  }

  onStatus("Unzipping EPUB...");
  var zip = await jszip.loadAsync(arrayBuffer);
  var resolver = createResolver(zip);

  onStatus("Parsing container.xml...");
  var opfPath = await locateOpfPath(resolver);
  if (!opfPath) {
    throw new Error("Could not locate the OPF file (missing container.xml or .opf).");
  }

  var opfText = await resolver.readText(opfPath);
  var opfDoc = parseXml(opfText);
  var opfInfo = parseOpf(opfDoc);
  var opfDir = dirname(opfPath);

  onStatus("Parsing table of contents (TOC)...");
  var tocData = await parseToc(resolver, opfInfo, opfDir);

  onStatus("Loading chapters...");
  var chapters = await loadSpineChapters(resolver, opfInfo, opfDir, tocData, {
    onChapterStatus: onStatus,
    mediaAssetRegistry: mediaAssetRegistry
  });

  return {
    title: opfInfo.title || "",
    opfPath: opfPath,
    opfInfo: opfInfo,
    tocData: tocData,
    chapters: chapters,
    mediaAssetRegistry: mediaAssetRegistry
  };
}

export function humanizeTocSource(source) {
  if (source === "ncx") {
    return "toc.ncx";
  }
  if (source === "nav") {
    return "EPUB3 nav";
  }
  return "spine fallback";
}

export function createResolver(zip) {
  var exact = new Map();
  var lower = new Map();

  Object.keys(zip.files).forEach(function (name) {
    var entry = zip.files[name];
    if (entry.dir) {
      return;
    }
    var norm = normalizePath(name);
    exact.set(norm, name);
    lower.set(norm.toLowerCase(), name);
  });

  return {
    findFirst: function (regex) {
      var found = "";
      exact.forEach(function (_real, path) {
        if (!found && regex.test(path)) {
          found = path;
        }
      });
      return found;
    },
    resolve: function (path) {
      var norm = normalizePath(path);
      var matched = exact.get(norm) || lower.get(norm.toLowerCase()) || "";
      if (matched) {
        return matched;
      }
      var decoded = safeDecode(norm);
      if (decoded !== norm) {
        return exact.get(decoded) || lower.get(decoded.toLowerCase()) || "";
      }
      return "";
    },
    has: function (path) {
      return !!this.resolve(path);
    },
    readText: async function (path) {
      var real = this.resolve(path);
      if (!real) {
        throw new Error("File not found: " + path);
      }
      return zip.file(real).async("string");
    },
    readBinary: async function (path) {
      var real = this.resolve(path);
      if (!real) {
        throw new Error("File not found: " + path);
      }
      return zip.file(real).async("uint8array");
    }
  };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (_error) {
    return text;
  }
}

export async function locateOpfPath(resolver) {
  var containerPath = resolver.resolve("META-INF/container.xml");
  if (containerPath) {
    var containerText = await resolver.readText(containerPath);
    var containerDoc = parseXml(containerText);
    var rootfiles = byLocalName(containerDoc, "rootfile");
    for (var i = 0; i < rootfiles.length; i += 1) {
      var fullPath = rootfiles[i].getAttribute("full-path");
      if (fullPath && resolver.has(fullPath)) {
        return normalizePath(fullPath);
      }
    }
  }

  return resolver.findFirst(/\.opf$/i);
}

export function parseOpf(opfDoc) {
  var title = "";
  var manifest = new Map();
  var spine = [];
  var spineTocId = "";

  var titleNode = firstByTag(opfDoc, ["dc:title", "title"]);
  if (titleNode) {
    title = cleanText(titleNode.textContent);
  }

  var spineNode = byLocalName(opfDoc, "spine")[0];
  if (spineNode) {
    spineTocId = spineNode.getAttribute("toc") || "";
  }

  var items = byLocalName(opfDoc, "item");
  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    if (!item.parentNode || localName(item.parentNode) !== "manifest") {
      continue;
    }
    var id = item.getAttribute("id") || "";
    var href = item.getAttribute("href") || "";
    if (!id || !href) {
      continue;
    }
    manifest.set(id, {
      id: id,
      href: href,
      mediaType: item.getAttribute("media-type") || "",
      properties: item.getAttribute("properties") || ""
    });
  }

  var itemRefs = byLocalName(opfDoc, "itemref");
  for (var j = 0; j < itemRefs.length; j += 1) {
    var itemref = itemRefs[j];
    if (!itemref.parentNode || localName(itemref.parentNode) !== "spine") {
      continue;
    }
    var idref = itemref.getAttribute("idref") || "";
    if (idref) {
      spine.push(idref);
    }
  }

  return {
    title: title,
    manifest: manifest,
    spine: spine,
    spineTocId: spineTocId
  };
}

export async function parseToc(resolver, opfInfo, opfDir) {
  var manifest = opfInfo.manifest;
  var spineTocId = opfInfo.spineTocId;

  if (spineTocId && manifest.has(spineTocId)) {
    var tocItem = manifest.get(spineTocId);
    var ncxPath = resolveRelative(opfDir, tocItem.href);
    if (resolver.has(ncxPath)) {
      var ncxText = await resolver.readText(ncxPath);
      var ncxDoc = parseXml(ncxText);
      var navMap = byLocalName(ncxDoc, "navMap")[0];
      if (navMap) {
        return {
          source: "ncx",
          baseDir: dirname(ncxPath),
          items: parseNcxPoints(childrenByLocal(navMap, "navPoint"))
        };
      }
    }
  }

  var navItem = null;
  manifest.forEach(function (item) {
    if (navItem) {
      return;
    }
    if ((item.properties || "").split(/\s+/).indexOf("nav") >= 0) {
      navItem = item;
    }
  });

  if (navItem) {
    var navPath = resolveRelative(opfDir, navItem.href);
    if (resolver.has(navPath)) {
      var navText = await resolver.readText(navPath);
      var navDoc = parseXml(navText);
      var navNode = pickTocNavNode(navDoc);
      if (navNode) {
        var rootList = firstChildByLocal(navNode, ["ol", "ul"]) || byLocalName(navNode, "ol")[0] || byLocalName(navNode, "ul")[0];
        if (rootList) {
          return {
            source: "nav",
            baseDir: dirname(navPath),
            items: parseNavList(rootList)
          };
        }
      }
    }
  }

  return {
    source: "spine-fallback",
    baseDir: opfDir,
    items: []
  };
}

function parseNcxPoints(nodes) {
  var out = [];
  for (var i = 0; i < nodes.length; i += 1) {
    var navPoint = nodes[i];
    var navLabel = firstChildByLocal(navPoint, ["navLabel"]);
    var textNode = navLabel ? firstChildByLocal(navLabel, ["text"]) : null;
    var contentNode = firstChildByLocal(navPoint, ["content"]);
    out.push({
      title: cleanText(textNode ? textNode.textContent : navLabel ? navLabel.textContent : "Untitled"),
      href: contentNode ? (contentNode.getAttribute("src") || "") : "",
      children: parseNcxPoints(childrenByLocal(navPoint, "navPoint"))
    });
  }
  return out;
}

function pickTocNavNode(doc) {
  var navNodes = byLocalName(doc, "nav");
  for (var i = 0; i < navNodes.length; i += 1) {
    var nav = navNodes[i];
    var role = (nav.getAttribute("role") || "").toLowerCase();
    var epubType = (nav.getAttribute("epub:type") || nav.getAttribute("type") || "").toLowerCase();
    if (role === "doc-toc" || epubType.indexOf("toc") >= 0) {
      return nav;
    }
    var attrs = nav.attributes || [];
    for (var k = 0; k < attrs.length; k += 1) {
      if (attrs[k].name && attrs[k].name.toLowerCase().indexOf("type") >= 0 && (attrs[k].value || "").toLowerCase().indexOf("toc") >= 0) {
        return nav;
      }
    }
  }
  return navNodes[0] || null;
}

function parseNavList(listNode) {
  var out = [];
  var liNodes = childrenByLocal(listNode, "li");
  for (var i = 0; i < liNodes.length; i += 1) {
    var li = liNodes[i];
    var labelNode = firstChildByLocal(li, ["a", "span", "p", "div"]);
    var listChild = firstChildByLocal(li, ["ol", "ul"]);
    out.push({
      title: cleanText(labelNode ? labelNode.textContent : li.textContent || "Untitled"),
      href: labelNode && localName(labelNode) === "a" ? (labelNode.getAttribute("href") || "") : "",
      children: listChild ? parseNavList(listChild) : []
    });
  }
  return out;
}

export async function loadSpineChapters(resolver, opfInfo, opfDir, tocData, options) {
  var opts = options || {};
  var onChapterStatus = typeof opts.onChapterStatus === "function" ? opts.onChapterStatus : function () {};
  var mediaAssetRegistry = opts.mediaAssetRegistry || createMediaAssetRegistry();

  var manifest = opfInfo.manifest;
  var spine = opfInfo.spine;
  var titleByPath = buildTocTitleMap(tocData.items, tocData.baseDir);
  var mediaTypeByPath = buildMediaTypeByPath(manifest, opfDir);
  var chapters = [];

  for (var i = 0; i < spine.length; i += 1) {
    onChapterStatus("Loading chapter " + (i + 1) + " / " + spine.length + " ...");
    var idref = spine[i];
    if (!manifest.has(idref)) {
      continue;
    }
    var item = manifest.get(idref);
    var path = resolveRelative(opfDir, item.href);
    if (!resolver.has(path)) {
      continue;
    }

    var mediaType = (item.mediaType || "").toLowerCase();
    var isHtml = mediaType.indexOf("xhtml") >= 0 || mediaType.indexOf("html") >= 0 || /\.x?html?$/i.test(path);
    if (!isHtml) {
      continue;
    }

    var chapterText = await resolver.readText(path);
    var bodyHtml = extractBodyMarkup(chapterText);
    if (!bodyHtml) {
      continue;
    }

    var heading = titleByPath.get(path) || extractFirstHeading(chapterText) || stripExt(path.split("/").pop() || ("chapter-" + (i + 1)));
    var sectionPrefix = "ch" + (i + 1);
    var prepared = await prepareChapterHtml(bodyHtml, sectionPrefix, resolver, dirname(path), mediaTypeByPath, mediaAssetRegistry);

    chapters.push({
      index: i + 1,
      path: path,
      title: heading,
      html: prepared.html,
      idMap: prepared.idMap
    });
  }

  return chapters;
}

export function resolveTargetRef(baseDir, href) {
  var raw = (href || "").trim();
  var hashIdx = raw.indexOf("#");
  var pathPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  var frag = hashIdx >= 0 ? decodeURIComponent(raw.slice(hashIdx + 1)) : "";

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathPart)) {
    return { external: true, path: pathPart, fragment: frag };
  }

  if (!pathPart) {
    return { external: false, path: "", fragment: frag };
  }

  return {
    external: false,
    path: resolveRelative(baseDir, pathPart),
    fragment: frag
  };
}

export function resolveRelative(baseDir, hrefPath) {
  if (!hrefPath) {
    return normalizePath(baseDir || "");
  }
  if (hrefPath.indexOf("/") === 0) {
    return normalizePath(hrefPath.slice(1));
  }
  var base = baseDir ? baseDir + "/" : "";
  return normalizePath(base + hrefPath);
}

export function dirname(path) {
  var norm = normalizePath(path);
  var idx = norm.lastIndexOf("/");
  return idx < 0 ? "" : norm.slice(0, idx);
}

export function normalizePath(path) {
  var input = (path || "").replace(/\\/g, "/");
  var parts = input.split("/");
  var out = [];
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i];
    if (!p || p === ".") {
      continue;
    }
    if (p === "..") {
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join("/");
}

export function parseXml(text) {
  var parser = new DOMParser();
  var xmlDoc = parser.parseFromString(text, "application/xml");
  if (!hasParserError(xmlDoc)) {
    return xmlDoc;
  }
  return parser.parseFromString(text, "text/html");
}

function hasParserError(doc) {
  return byLocalName(doc, "parsererror").length > 0;
}

function getBodyFromDoc(doc) {
  if (!doc) {
    return null;
  }
  if (doc.body) {
    return doc.body;
  }
  var bodyNodes = byLocalName(doc, "body");
  return bodyNodes[0] || null;
}

function getInnerMarkup(node) {
  if (!node) {
    return "";
  }
  if (typeof node.innerHTML === "string") {
    return node.innerHTML;
  }
  var serializer = new XMLSerializer();
  var out = "";
  for (var i = 0; i < node.childNodes.length; i += 1) {
    out += serializer.serializeToString(node.childNodes[i]);
  }
  return out;
}

export function byLocalName(root, name) {
  if (!root || !name) {
    return [];
  }

  var result = [];
  var seen = new Set();

  var list1 = root.getElementsByTagName ? root.getElementsByTagName(name) : [];
  for (var i = 0; i < list1.length; i += 1) {
    if (!seen.has(list1[i])) {
      seen.add(list1[i]);
      result.push(list1[i]);
    }
  }

  if (root.getElementsByTagNameNS) {
    var list2 = root.getElementsByTagNameNS("*", name);
    for (var j = 0; j < list2.length; j += 1) {
      if (!seen.has(list2[j])) {
        seen.add(list2[j]);
        result.push(list2[j]);
      }
    }
  }

  return result;
}

function childrenByLocal(node, name) {
  if (!node || !node.childNodes) {
    return [];
  }
  var target = String(name || "").toLowerCase();
  var out = [];
  for (var i = 0; i < node.childNodes.length; i += 1) {
    var child = node.childNodes[i];
    if (child.nodeType !== 1) {
      continue;
    }
    if (localName(child) === target) {
      out.push(child);
    }
  }
  return out;
}

function firstChildByLocal(node, names) {
  if (!node || !node.childNodes) {
    return null;
  }
  var targets = (names || []).map(function (n) { return String(n).toLowerCase(); });
  for (var i = 0; i < node.childNodes.length; i += 1) {
    var child = node.childNodes[i];
    if (child.nodeType !== 1) {
      continue;
    }
    if (targets.indexOf(localName(child)) >= 0) {
      return child;
    }
  }
  return null;
}

function firstByTag(root, names) {
  for (var i = 0; i < names.length; i += 1) {
    var list = root.getElementsByTagName(names[i]);
    if (list && list.length) {
      return list[0];
    }
  }
  for (var j = 0; j < names.length; j += 1) {
    var local = names[j].indexOf(":") >= 0 ? names[j].split(":")[1] : names[j];
    var listNs = byLocalName(root, local);
    if (listNs.length) {
      return listNs[0];
    }
  }
  return null;
}

export function localName(node) {
  return (node.localName || node.nodeName || "").toLowerCase().replace(/^.*:/, "");
}

export function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function slugify(text) {
  var s = (text || "").toLowerCase().replace(/[^a-z0-9_\-:.]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "id";
}

export function stripExt(name) {
  return name.replace(/\.[^.]+$/, "");
}

export function buildSpineFallbackToc(chapters) {
  return chapters.map(function (chapter) {
    return {
      title: chapter.title,
      href: chapter.path,
      children: []
    };
  });
}

function buildTocTitleMap(items, baseDir) {
  var map = new Map();
  walkToc(items, function (item) {
    if (!item.href) {
      return;
    }
    var ref = resolveTargetRef(baseDir, item.href);
    if (ref.path && !map.has(ref.path)) {
      map.set(ref.path, item.title || "");
    }
  });
  return map;
}

function walkToc(items, visit) {
  for (var i = 0; i < items.length; i += 1) {
    visit(items[i]);
    if (items[i].children && items[i].children.length) {
      walkToc(items[i].children, visit);
    }
  }
}

function extractBodyMarkup(raw) {
  var doc = parseXml(raw);
  var body = getBodyFromDoc(doc);
  if (body) {
    return getInnerMarkup(body);
  }
  var fallback = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return fallback ? fallback[1] : "";
}

function extractFirstHeading(raw) {
  var doc = parseXml(raw);
  var body = getBodyFromDoc(doc) || doc;
  var tags = ["h1", "h2", "h3", "h4", "h5", "h6"];
  for (var i = 0; i < tags.length; i += 1) {
    var nodes = byLocalName(body, tags[i]);
    if (nodes.length) {
      var txt = cleanText(nodes[0].textContent);
      if (txt) {
        return txt;
      }
    }
  }
  return "";
}

async function prepareChapterHtml(rawHtml, prefix, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry) {
  var parser = new DOMParser();
  var doc = parser.parseFromString("<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>", "text/html");
  var root = doc.getElementById("root");
  root.innerHTML = rawHtml;

  var removeSelector = "script,style,meta,base,link[rel='stylesheet'],iframe,object,embed";
  var removeNodes = root.querySelectorAll(removeSelector);
  for (var i = 0; i < removeNodes.length; i += 1) {
    removeNodes[i].remove();
  }

  var idMap = new Map();
  var idNodes = root.querySelectorAll("[id]");
  for (var j = 0; j < idNodes.length; j += 1) {
    var oldId = idNodes[j].getAttribute("id") || "";
    if (!oldId) {
      continue;
    }
    var newId = prefix + "__" + slugify(oldId) + "__" + j;
    idMap.set(oldId, newId);
    idNodes[j].setAttribute("id", newId);
  }

  var hashLinks = root.querySelectorAll("a[href^='#']");
  for (var k = 0; k < hashLinks.length; k += 1) {
    var href = hashLinks[k].getAttribute("href") || "";
    var key = href.replace(/^#/, "");
    if (idMap.has(key)) {
      hashLinks[k].setAttribute("href", "#" + idMap.get(key));
    }
  }

  await rewriteEmbeddedMediaUrls(root, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry);
  trimEmptyEdges(root, 12);

  return {
    html: root.innerHTML,
    idMap: idMap
  };
}

async function rewriteEmbeddedMediaUrls(root, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry) {
  if (!root || !resolver) {
    return;
  }

  var attrTasks = [];
  var srcNodes = root.querySelectorAll("img[src],source[src],video[src],audio[src]");
  for (var i = 0; i < srcNodes.length; i += 1) {
    attrTasks.push(rewriteMediaAttr(srcNodes[i], "src", resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry));
  }

  var posterNodes = root.querySelectorAll("video[poster]");
  for (var j = 0; j < posterNodes.length; j += 1) {
    attrTasks.push(rewriteMediaAttr(posterNodes[j], "poster", resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry));
  }

  var svgImageNodes = root.querySelectorAll("image[href],image[xlink\\:href]");
  for (var k = 0; k < svgImageNodes.length; k += 1) {
    if (svgImageNodes[k].hasAttribute("href")) {
      attrTasks.push(rewriteMediaAttr(svgImageNodes[k], "href", resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry));
    }
    if (svgImageNodes[k].hasAttribute("xlink:href")) {
      attrTasks.push(rewriteMediaAttr(svgImageNodes[k], "xlink:href", resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry));
    }
  }

  await Promise.all(attrTasks);

  var srcsetNodes = root.querySelectorAll("img[srcset],source[srcset]");
  for (var n = 0; n < srcsetNodes.length; n += 1) {
    var srcset = srcsetNodes[n].getAttribute("srcset") || "";
    var rewrittenSrcset = await rewriteSrcsetValue(srcset, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry);
    if (rewrittenSrcset) {
      srcsetNodes[n].setAttribute("srcset", rewrittenSrcset);
    }
  }
}

async function rewriteMediaAttr(node, attrName, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry) {
  if (!node || !attrName) {
    return;
  }

  var raw = (node.getAttribute(attrName) || "").trim();
  if (!raw) {
    return;
  }

  var rewritten = await resolveEmbeddedMediaUrl(raw, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry);
  if (rewritten) {
    node.setAttribute(attrName, rewritten);
  }
}

async function rewriteSrcsetValue(value, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry) {
  var input = (value || "").trim();
  if (!input) {
    return "";
  }

  var entries = input.split(",");
  var out = [];
  for (var i = 0; i < entries.length; i += 1) {
    var token = entries[i].trim();
    if (!token) {
      continue;
    }

    var splitAt = token.search(/\s/);
    var urlPart = splitAt < 0 ? token : token.slice(0, splitAt);
    var descriptor = splitAt < 0 ? "" : token.slice(splitAt).trim();
    var rewritten = await resolveEmbeddedMediaUrl(urlPart, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry);

    if (!rewritten) {
      out.push(token);
      continue;
    }
    out.push(descriptor ? rewritten + " " + descriptor : rewritten);
  }

  return out.join(", ");
}

async function resolveEmbeddedMediaUrl(rawUrl, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry) {
  var parsed = splitResourceUrl(rawUrl || "");
  if (!parsed.path || isNonLocalUrl(parsed.path)) {
    return "";
  }

  var resolvedPath = resolveRelative(chapterDir || "", parsed.path);
  if (!resolvedPath || !resolver.has(resolvedPath)) {
    return "";
  }

  var mediaUrl = await getOrCreateMediaAssetUrl(mediaAssetRegistry, resolver, resolvedPath, mediaTypeByPath);
  if (!mediaUrl) {
    return "";
  }

  return mediaUrl + parsed.suffix;
}

function splitResourceUrl(raw) {
  var text = (raw || "").trim();
  var hashIdx = text.indexOf("#");
  var beforeHash = hashIdx >= 0 ? text.slice(0, hashIdx) : text;
  var hashSuffix = hashIdx >= 0 ? text.slice(hashIdx) : "";

  var queryIdx = beforeHash.indexOf("?");
  var path = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
  var querySuffix = queryIdx >= 0 ? beforeHash.slice(queryIdx) : "";

  return {
    path: path,
    suffix: querySuffix + hashSuffix
  };
}

function isNonLocalUrl(path) {
  var value = (path || "").trim().toLowerCase();
  if (!value) {
    return true;
  }
  if (value.indexOf("//") === 0) {
    return true;
  }
  if (value.indexOf("data:") === 0 || value.indexOf("blob:") === 0 || value.indexOf("#") === 0) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:/.test(value)) {
    return true;
  }
  return false;
}

async function getOrCreateMediaAssetUrl(mediaAssetRegistry, resolver, path, mediaTypeByPath) {
  if (!mediaAssetRegistry || typeof mediaAssetRegistry.getOrCreate !== "function") {
    return "";
  }
  return mediaAssetRegistry.getOrCreate(resolver, path, mediaTypeByPath);
}

function buildMediaTypeByPath(manifest, opfDir) {
  var map = new Map();
  if (!manifest || !manifest.forEach) {
    return map;
  }

  manifest.forEach(function (item) {
    if (!item || !item.href) {
      return;
    }
    var path = resolveRelative(opfDir || "", item.href);
    map.set(path, item.mediaType || "");
  });
  return map;
}

function guessMediaType(path) {
  var lower = (path || "").toLowerCase();
  if (/\.avif$/.test(lower)) { return "image/avif"; }
  if (/\.bmp$/.test(lower)) { return "image/bmp"; }
  if (/\.gif$/.test(lower)) { return "image/gif"; }
  if (/\.ico$/.test(lower)) { return "image/x-icon"; }
  if (/\.jpe?g$/.test(lower)) { return "image/jpeg"; }
  if (/\.png$/.test(lower)) { return "image/png"; }
  if (/\.svg$/.test(lower)) { return "image/svg+xml"; }
  if (/\.tiff?$/.test(lower)) { return "image/tiff"; }
  if (/\.webp$/.test(lower)) { return "image/webp"; }
  if (/\.mp3$/.test(lower)) { return "audio/mpeg"; }
  if (/\.m4a$/.test(lower)) { return "audio/mp4"; }
  if (/\.ogg$/.test(lower)) { return "audio/ogg"; }
  if (/\.wav$/.test(lower)) { return "audio/wav"; }
  if (/\.mp4$/.test(lower)) { return "video/mp4"; }
  if (/\.webm$/.test(lower)) { return "video/webm"; }
  return "application/octet-stream";
}

function trimEmptyEdges(root, maxCount) {
  var count = 0;
  while (root.firstElementChild && count < maxCount && isEmptyBlock(root.firstElementChild)) {
    root.firstElementChild.remove();
    count += 1;
  }
  count = 0;
  while (root.lastElementChild && count < maxCount && isEmptyBlock(root.lastElementChild)) {
    root.lastElementChild.remove();
    count += 1;
  }
}

function isEmptyBlock(node) {
  if (!node || node.nodeType !== 1) {
    return false;
  }
  var tag = localName(node);
  var allowed = ["p", "div", "span"];
  if (allowed.indexOf(tag) < 0) {
    return false;
  }
  if (node.querySelector("img,svg,video,audio,table,ul,ol,blockquote,pre,code")) {
    return false;
  }
  var txt = (node.textContent || "").replace(/\u00a0/g, "").trim();
  return txt.length === 0;
}

export function findChapterPathByFragment(fragment, idMapByPath) {
  var matched = "";
  if (!fragment) {
    return matched;
  }
  idMapByPath.forEach(function (idMap, path) {
    if (!matched && idMap && idMap.has(fragment)) {
      matched = path;
    }
  });
  return matched;
}
