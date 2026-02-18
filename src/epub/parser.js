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

function createAuditCollector() {
  return {
    spineItems: [],
    tocTargets: [],
    referencedResources: [],
    orphanManifestResources: [],
    encryptedResources: [],
    policyBlocks: {
      remoteResources: 0,
      fileScheme: 0,
      outOfContainer: 0,
      missingResources: 0,
      unsupportedScheme: 0
    },
    warnings: [],
    summary: {
      totalSpineItems: 0,
      renderedSpineItems: 0,
      missingSpineItems: 0,
      missingTocTargets: 0,
      totalReferencedResources: 0,
      missingReferencedResources: 0,
      blockedByPolicy: 0,
      encryptedManifestResources: 0
    }
  };
}

export async function parseEpubFromArrayBuffer(arrayBuffer, options) {
  var opts = options || {};
  var jszip = opts.jszip;
  var onStatus = typeof opts.onStatus === "function" ? opts.onStatus : function () {};
  var mediaAssetRegistry = opts.mediaAssetRegistry || createMediaAssetRegistry();
  var audit = createAuditCollector();

  if (!jszip || typeof jszip.loadAsync !== "function") {
    throw new Error("JSZip is required to parse EPUB archives.");
  }

  onStatus("Unzipping EPUB...");
  var zip = await jszip.loadAsync(arrayBuffer);
  var resolver = createResolver(zip);

  onStatus("Parsing container.xml...");
  var containerInfo = await parseContainerInfo(resolver);
  var opfPath = await locateOpfPath(resolver, { containerInfo: containerInfo });
  if (!opfPath) {
    throw new Error("Could not locate the OPF file (missing container.xml or .opf).");
  }

  var opfText = await resolver.readText(opfPath);
  var opfDoc = parseXml(opfText);
  var opfDir = dirname(opfPath);
  var opfInfo = parseOpf(opfDoc, { opfDir: opfDir, resolver: resolver });

  onStatus("Parsing encryption.xml...");
  var encryptionInfo = await parseEncryptionInfo(resolver);
  attachEncryptionInfoToManifest(opfInfo, encryptionInfo);
  for (var encIndex = 0; encIndex < encryptionInfo.resources.length; encIndex += 1) {
    if (encryptionInfo.resources[encIndex].supported) {
      continue;
    }
    audit.warnings.push(
      "Encrypted resource may not be renderable: " +
      encryptionInfo.resources[encIndex].path +
      " (" + (encryptionInfo.resources[encIndex].algorithm || "unknown algorithm") + ")"
    );
  }

  onStatus("Parsing table of contents (TOC)...");
  var tocData = await parseToc(resolver, opfInfo, opfDir);

  onStatus("Loading chapters...");
  var chapters = await loadSpineChapters(resolver, opfInfo, opfDir, tocData, {
    onChapterStatus: onStatus,
    mediaAssetRegistry: mediaAssetRegistry,
    auditCollector: audit
  });

  finalizeAuditReport(audit, chapters, tocData, opfInfo, resolver, encryptionInfo);

  return {
    title: opfInfo.title || "",
    containerInfo: containerInfo,
    encryptionInfo: encryptionInfo,
    opfPath: opfPath,
    opfInfo: opfInfo,
    tocData: tocData,
    chapters: chapters,
    mediaAssetRegistry: mediaAssetRegistry,
    audit: audit
  };
}

function finalizeAuditReport(audit, chapters, tocData, opfInfo, resolver, encryptionInfo) {
  if (!audit) {
    return;
  }

  var manifest = opfInfo && opfInfo.manifest ? opfInfo.manifest : new Map();
  var manifestByPath = opfInfo && opfInfo.manifestByPath ? opfInfo.manifestByPath : new Map();
  var chapterPathSet = new Set();
  for (var i = 0; i < chapters.length; i += 1) {
    chapterPathSet.add(chapters[i].path);
  }

  var missingTocTargets = [];
  var tocNodes = [];
  flattenTocItems(tocData && tocData.items ? tocData.items : [], tocNodes);
  for (var j = 0; j < tocNodes.length; j += 1) {
    var href = String(tocNodes[j].href || "").trim();
    if (!href) {
      continue;
    }
    var ref = resolveTargetRef(tocData && tocData.baseDir ? tocData.baseDir : "", href);
    if (ref.external || !ref.path) {
      continue;
    }
    var existsInChapters = chapterPathSet.has(ref.path);
    var existsInManifest = manifestByPath.has(ref.path);
    var existsInContainer = !!(resolver && resolver.has(ref.path));
    var exists = existsInChapters || existsInManifest || existsInContainer;
    audit.tocTargets.push({
      href: href,
      path: ref.path,
      exists: exists,
      existsInChapters: existsInChapters,
      existsInManifest: existsInManifest
    });
    if (!exists) {
      missingTocTargets.push(ref.path);
    }
  }

  var referencedPathSet = new Set();
  var missingReferencedResources = 0;
  var blockedByPolicy = 0;

  for (var refIndex = 0; refIndex < audit.referencedResources.length; refIndex += 1) {
    var refItem = audit.referencedResources[refIndex];
    if (refItem.path) {
      referencedPathSet.add(refItem.path);
    }
    if (refItem.status === "missing-resource") {
      missingReferencedResources += 1;
      audit.policyBlocks.missingResources += 1;
      continue;
    }
    if (refItem.status === "remote-resource" || refItem.status === "protocol-relative") {
      blockedByPolicy += 1;
      audit.policyBlocks.remoteResources += 1;
      continue;
    }
    if (refItem.status === "blocked-file-scheme") {
      blockedByPolicy += 1;
      audit.policyBlocks.fileScheme += 1;
      continue;
    }
    if (refItem.status === "out-of-container") {
      blockedByPolicy += 1;
      audit.policyBlocks.outOfContainer += 1;
      continue;
    }
    if (refItem.status === "unsupported-scheme") {
      blockedByPolicy += 1;
      audit.policyBlocks.unsupportedScheme += 1;
    }
  }

  for (var spineAuditIndex = 0; spineAuditIndex < audit.spineItems.length; spineAuditIndex += 1) {
    var spineAuditItem = audit.spineItems[spineAuditIndex];
    if (spineAuditItem.status === "remote-resource") {
      blockedByPolicy += 1;
      audit.policyBlocks.remoteResources += 1;
      continue;
    }
    if (spineAuditItem.status === "out-of-container") {
      blockedByPolicy += 1;
      audit.policyBlocks.outOfContainer += 1;
      continue;
    }
    if (spineAuditItem.status === "missing-resource") {
      missingReferencedResources += 1;
      audit.policyBlocks.missingResources += 1;
    }
  }

  manifest.forEach(function (manifestItem) {
    if (!manifestItem || manifestItem.isRemote || !manifestItem.resolvedPath) {
      return;
    }
    if (chapterPathSet.has(manifestItem.resolvedPath)) {
      return;
    }
    if (referencedPathSet.has(manifestItem.resolvedPath)) {
      return;
    }
    audit.orphanManifestResources.push({
      id: manifestItem.id,
      path: manifestItem.resolvedPath,
      mediaType: manifestItem.mediaType || ""
    });
  });

  if (encryptionInfo && encryptionInfo.resources) {
    audit.encryptedResources = encryptionInfo.resources.slice();
  }

  audit.summary.totalSpineItems = audit.spineItems.length;
  audit.summary.renderedSpineItems = chapters.length;
  audit.summary.missingSpineItems = Math.max(0, audit.spineItems.length - chapters.length);
  audit.summary.missingTocTargets = missingTocTargets.length;
  audit.summary.totalReferencedResources = audit.referencedResources.length;
  audit.summary.missingReferencedResources = missingReferencedResources;
  audit.summary.blockedByPolicy = blockedByPolicy;
  audit.summary.encryptedManifestResources = encryptionInfo && encryptionInfo.resources ? encryptionInfo.resources.length : 0;
}

function flattenTocItems(items, out) {
  for (var i = 0; i < items.length; i += 1) {
    out.push(items[i]);
    if (items[i].children && items[i].children.length) {
      flattenTocItems(items[i].children, out);
    }
  }
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
    listPaths: function () {
      return Array.from(exact.keys());
    },
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
      var normalized = normalizePathDetails(path);
      if (normalized.outOfContainer) {
        return "";
      }
      var norm = normalized.path;
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

export async function parseContainerInfo(resolver) {
  var info = {
    containerPath: "",
    rootfiles: [],
    links: [],
    metaInf: {
      encryptionXmlPath: "",
      signaturesXmlPath: "",
      rightsXmlPath: "",
      metadataXmlPath: "",
      manifestXmlPath: ""
    },
    warnings: []
  };

  var containerPath = resolver.resolve("META-INF/container.xml");
  if (!containerPath) {
    info.warnings.push("Missing META-INF/container.xml");
    return info;
  }

  info.containerPath = normalizePath(containerPath);
  var containerText = await resolver.readText(containerPath);
  var containerDoc = parseXml(containerText);
  var rootfileNodes = byLocalName(containerDoc, "rootfile");
  for (var i = 0; i < rootfileNodes.length; i += 1) {
    var pathDetails = normalizePathDetails(rootfileNodes[i].getAttribute("full-path") || "");
    var fullPath = pathDetails.path;
    if (!fullPath) {
      continue;
    }
    if (pathDetails.outOfContainer) {
      info.warnings.push("Ignoring out-of-container rootfile path: " + fullPath);
      continue;
    }
    info.rootfiles.push({
      fullPath: fullPath,
      mediaType: rootfileNodes[i].getAttribute("media-type") || "",
      rendition: {
        media: rootfileNodes[i].getAttribute("rendition:media") || "",
        layout: rootfileNodes[i].getAttribute("rendition:layout") || "",
        language: rootfileNodes[i].getAttribute("rendition:language") || "",
        accessMode: rootfileNodes[i].getAttribute("rendition:accessMode") || ""
      }
    });
  }

  if (!info.rootfiles.length) {
    info.warnings.push("No rootfile entries found in container.xml");
  }

  var linkNodes = byLocalName(containerDoc, "link");
  for (var j = 0; j < linkNodes.length; j += 1) {
    var href = (linkNodes[j].getAttribute("href") || "").trim();
    if (!href) {
      continue;
    }
    info.links.push({
      href: href,
      rel: (linkNodes[j].getAttribute("rel") || "").trim(),
      mediaType: (linkNodes[j].getAttribute("media-type") || "").trim()
    });
  }

  info.metaInf.encryptionXmlPath = resolveMetaInfPathIfExists(resolver, "META-INF/encryption.xml");
  info.metaInf.signaturesXmlPath = resolveMetaInfPathIfExists(resolver, "META-INF/signatures.xml");
  info.metaInf.rightsXmlPath = resolveMetaInfPathIfExists(resolver, "META-INF/rights.xml");
  info.metaInf.metadataXmlPath = resolveMetaInfPathIfExists(resolver, "META-INF/metadata.xml");
  info.metaInf.manifestXmlPath = resolveMetaInfPathIfExists(resolver, "META-INF/manifest.xml");

  return info;
}

function resolveMetaInfPathIfExists(resolver, path) {
  if (!resolver || typeof resolver.resolve !== "function") {
    return "";
  }
  var resolved = resolver.resolve(path);
  return resolved ? normalizePath(resolved) : "";
}

export async function locateOpfPath(resolver, options) {
  var opts = options || {};
  var containerInfo = opts.containerInfo || await parseContainerInfo(resolver);

  for (var i = 0; i < containerInfo.rootfiles.length; i += 1) {
    var rootfile = containerInfo.rootfiles[i];
    var mediaType = (rootfile.mediaType || "").toLowerCase();
    if (mediaType && mediaType !== "application/oebps-package+xml") {
      continue;
    }
    if (rootfile.fullPath && resolver.has(rootfile.fullPath)) {
      return normalizePath(rootfile.fullPath);
    }
  }

  for (var j = 0; j < containerInfo.rootfiles.length; j += 1) {
    if (containerInfo.rootfiles[j].fullPath && resolver.has(containerInfo.rootfiles[j].fullPath)) {
      return normalizePath(containerInfo.rootfiles[j].fullPath);
    }
  }

  return resolver.findFirst(/\.opf$/i) || "";
}

var SUPPORTED_FONT_OBFUSCATION_ALGORITHMS = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#rc"
]);

function isSupportedFontObfuscationAlgorithm(algorithm) {
  return SUPPORTED_FONT_OBFUSCATION_ALGORITHMS.has(String(algorithm || "").toLowerCase());
}

export async function parseEncryptionInfo(resolver) {
  var result = {
    path: "",
    resources: [],
    byPath: new Map(),
    warnings: []
  };

  var encryptionPath = resolver && typeof resolver.resolve === "function" ? resolver.resolve("META-INF/encryption.xml") : "";
  if (!encryptionPath) {
    return result;
  }

  result.path = normalizePath(encryptionPath);
  var raw = await resolver.readText(encryptionPath);
  var doc = parseXml(raw);
  var encryptedDataNodes = byLocalName(doc, "EncryptedData");

  for (var i = 0; i < encryptedDataNodes.length; i += 1) {
    var encryptedDataNode = encryptedDataNodes[i];
    var encryptionMethod = firstChildByLocal(encryptedDataNode, ["EncryptionMethod"]);
    var cipherData = firstChildByLocal(encryptedDataNode, ["CipherData"]);
    var cipherReference = cipherData ? firstChildByLocal(cipherData, ["CipherReference"]) : null;
    var uri = cipherReference ? (cipherReference.getAttribute("URI") || "").trim() : "";
    if (!uri) {
      continue;
    }
    var algorithm = encryptionMethod ? (encryptionMethod.getAttribute("Algorithm") || "") : "";
    var resolvedPath = normalizePath(uri.replace(/^\//, ""));
    var encryptionItem = {
      path: resolvedPath,
      algorithm: algorithm,
      supported: isSupportedFontObfuscationAlgorithm(algorithm)
    };
    result.resources.push(encryptionItem);
    if (!result.byPath.has(resolvedPath)) {
      result.byPath.set(resolvedPath, encryptionItem);
    }
  }

  return result;
}

function attachEncryptionInfoToManifest(opfInfo, encryptionInfo) {
  if (!opfInfo || !opfInfo.manifest || !encryptionInfo || !encryptionInfo.byPath) {
    return;
  }

  opfInfo.manifest.forEach(function (item) {
    if (!item || !item.resolvedPath) {
      return;
    }
    if (!encryptionInfo.byPath.has(item.resolvedPath)) {
      return;
    }
    var encryptionData = encryptionInfo.byPath.get(item.resolvedPath);
    item.encryption = {
      algorithm: encryptionData.algorithm,
      supported: !!encryptionData.supported
    };
  });
}

export function parseOpf(opfDoc, options) {
  var opts = options || {};
  var opfDir = opts.opfDir || "";
  var resolver = opts.resolver || null;
  var title = "";
  var manifest = new Map();
  var manifestByPath = new Map();
  var spine = [];
  var spineItems = [];
  var linearReadingOrder = [];
  var nonLinearItems = [];
  var resolvedReadingOrder = [];
  var spineTocId = "";
  var pageProgressionDirection = "default";
  var identifiers = [];
  var uniqueIdentifierId = "";
  var primaryIdentifier = "";
  var navItemId = "";
  var packageNode = byLocalName(opfDoc, "package")[0];
  var version = packageNode ? (packageNode.getAttribute("version") || "") : "";
  var metadataNode = byLocalName(opfDoc, "metadata")[0] || null;
  var metadata = parsePackageMetadata(metadataNode);

  if (packageNode) {
    uniqueIdentifierId = packageNode.getAttribute("unique-identifier") || "";
  }

  var titleNode = firstByTag(opfDoc, ["dc:title", "title"]);
  if (titleNode) {
    title = cleanText(titleNode.textContent);
  }
  if (!title && metadata.dc.title.length) {
    title = metadata.dc.title[0];
  }

  identifiers = metadata.identifiers.slice();

  if (uniqueIdentifierId) {
    for (var idIndex = 0; idIndex < identifiers.length; idIndex += 1) {
      if (identifiers[idIndex].id === uniqueIdentifierId) {
        primaryIdentifier = identifiers[idIndex].value;
        break;
      }
    }
  }
  if (!primaryIdentifier && identifiers.length) {
    primaryIdentifier = identifiers[0].value;
  }

  var spineNode = byLocalName(opfDoc, "spine")[0];
  if (spineNode) {
    spineTocId = spineNode.getAttribute("toc") || "";
    pageProgressionDirection = spineNode.getAttribute("page-progression-direction") || "default";
  }

  var items = byLocalName(opfDoc, "item");
  for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    var item = items[itemIndex];
    if (!item.parentNode || localName(item.parentNode) !== "manifest") {
      continue;
    }
    var id = item.getAttribute("id") || "";
    var href = item.getAttribute("href") || "";
    if (!id || !href) {
      continue;
    }
    var properties = item.getAttribute("properties") || "";
    var propertiesList = tokenizeProperties(properties);
    var resolved = resolveManifestHref(opfDir, href, resolver);
    var manifestItem = {
      id: id,
      href: href,
      mediaType: item.getAttribute("media-type") || "",
      properties: properties,
      propertiesList: propertiesList,
      propertiesSet: new Set(propertiesList),
      fallback: item.getAttribute("fallback") || "",
      mediaOverlay: item.getAttribute("media-overlay") || "",
      resolvedPath: resolved.path,
      isRemote: resolved.isRemote,
      outOfContainer: resolved.outOfContainer
    };
    manifest.set(id, manifestItem);
    if (manifestItem.resolvedPath && !manifestByPath.has(manifestItem.resolvedPath)) {
      manifestByPath.set(manifestItem.resolvedPath, manifestItem);
    }
    if (!navItemId && manifestItem.propertiesSet.has("nav")) {
      navItemId = manifestItem.id;
    }
  }

  var itemRefs = byLocalName(opfDoc, "itemref");
  for (var refIndex = 0; refIndex < itemRefs.length; refIndex += 1) {
    var itemref = itemRefs[refIndex];
    if (!itemref.parentNode || localName(itemref.parentNode) !== "spine") {
      continue;
    }
    var idref = itemref.getAttribute("idref") || "";
    if (idref) {
      spine.push(idref);
      var linearRaw = (itemref.getAttribute("linear") || "").toLowerCase();
      var spineProperties = tokenizeProperties(itemref.getAttribute("properties") || "");
      spineItems.push({
        idref: idref,
        linear: linearRaw !== "no",
        properties: spineProperties,
        propertiesSet: new Set(spineProperties)
      });
    }
  }

  for (var spineIndex = 0; spineIndex < spineItems.length; spineIndex += 1) {
    if (spineItems[spineIndex].linear) {
      linearReadingOrder.push(spineItems[spineIndex]);
    } else {
      nonLinearItems.push(spineItems[spineIndex]);
    }
  }

  for (var orderIndex = 0; orderIndex < spineItems.length; orderIndex += 1) {
    var spineItemRef = spineItems[orderIndex];
    var resolved = resolveSpineItemToRenderable(manifest, spineItemRef.idref, opfDir, resolver);
    resolvedReadingOrder.push({
      index: orderIndex,
      idref: spineItemRef.idref,
      linear: spineItemRef.linear,
      status: resolved.status,
      path: resolved.path || "",
      resolvedManifestId: resolved.item ? resolved.item.id : "",
      fallbackChain: resolved.chain || []
    });
  }

  var guideReferences = parseGuideReferences(opfDoc, opfDir);
  var cover = detectCover(manifest, metadata.metaNames, guideReferences, opfDir, resolver);
  var bindings = parseBindings(opfDoc);
  var collections = parseCollections(opfDoc);

  var nav = null;
  if (navItemId && manifest.has(navItemId)) {
    var navItem = manifest.get(navItemId);
    nav = {
      id: navItemId,
      href: navItem.href,
      path: resolveManifestItemPath(navItem, opfDir, resolver)
    };
  }

  var ncx = null;
  if (spineTocId && manifest.has(spineTocId)) {
    var ncxItem = manifest.get(spineTocId);
    ncx = {
      id: spineTocId,
      href: ncxItem.href,
      path: resolveManifestItemPath(ncxItem, opfDir, resolver)
    };
  } else {
    manifest.forEach(function (item) {
      if (ncx) {
        return;
      }
      if ((item.mediaType || "").toLowerCase() === "application/x-dtbncx+xml") {
        ncx = {
          id: item.id,
          href: item.href,
          path: resolveManifestItemPath(item, opfDir, resolver)
        };
      }
    });
  }

  return {
    version: version,
    uniqueIdentifierId: uniqueIdentifierId,
    identifiers: identifiers,
    primaryIdentifier: primaryIdentifier,
    opfDir: opfDir,
    title: title,
    metadata: metadata,
    manifest: manifest,
    manifestByPath: manifestByPath,
    cover: cover,
    spine: spine,
    spineItems: spineItems,
    linearReadingOrder: linearReadingOrder,
    nonLinearItems: nonLinearItems,
    resolvedReadingOrder: resolvedReadingOrder,
    spineTocId: spineTocId,
    pageProgressionDirection: pageProgressionDirection,
    guide: guideReferences.length ? { references: guideReferences } : null,
    nav: nav,
    ncx: ncx,
    bindings: bindings,
    collections: collections
  };
}

function parsePackageMetadata(metadataNode) {
  var result = {
    identifiers: [],
    dc: {
      title: [],
      language: [],
      creator: [],
      contributor: [],
      publisher: [],
      subject: [],
      description: [],
      date: []
    },
    metaProperties: [],
    metaNames: [],
    links: []
  };

  if (!metadataNode) {
    return result;
  }

  var elementNodes = metadataNode.childNodes || [];
  for (var i = 0; i < elementNodes.length; i += 1) {
    var node = elementNodes[i];
    if (!node || node.nodeType !== 1) {
      continue;
    }
    var nodeLocalName = localName(node);
    var textValue = cleanText(node.textContent || "");

    if (nodeLocalName === "identifier") {
      if (!textValue) {
        continue;
      }
      result.identifiers.push({
        id: node.getAttribute("id") || "",
        value: textValue
      });
      continue;
    }

    if (nodeLocalName === "title" && textValue) {
      result.dc.title.push(textValue);
      continue;
    }
    if (nodeLocalName === "language" && textValue) {
      result.dc.language.push(textValue);
      continue;
    }
    if (nodeLocalName === "creator" && textValue) {
      result.dc.creator.push(textValue);
      continue;
    }
    if (nodeLocalName === "contributor" && textValue) {
      result.dc.contributor.push(textValue);
      continue;
    }
    if (nodeLocalName === "publisher" && textValue) {
      result.dc.publisher.push(textValue);
      continue;
    }
    if (nodeLocalName === "subject" && textValue) {
      result.dc.subject.push(textValue);
      continue;
    }
    if (nodeLocalName === "description" && textValue) {
      result.dc.description.push(textValue);
      continue;
    }
    if (nodeLocalName === "date" && textValue) {
      result.dc.date.push(textValue);
      continue;
    }

    if (nodeLocalName === "meta") {
      var property = (node.getAttribute("property") || "").trim();
      var metaName = (node.getAttribute("name") || "").trim();
      var content = (node.getAttribute("content") || "").trim();
      if (property) {
        result.metaProperties.push({
          property: property,
          value: content || textValue,
          refines: (node.getAttribute("refines") || "").trim(),
          scheme: (node.getAttribute("scheme") || "").trim(),
          id: (node.getAttribute("id") || "").trim()
        });
      } else if (metaName) {
        result.metaNames.push({
          name: metaName,
          content: content || textValue,
          id: (node.getAttribute("id") || "").trim()
        });
      }
      continue;
    }

    if (nodeLocalName === "link") {
      var href = (node.getAttribute("href") || "").trim();
      if (!href) {
        continue;
      }
      result.links.push({
        href: href,
        rel: (node.getAttribute("rel") || "").trim(),
        mediaType: (node.getAttribute("media-type") || "").trim(),
        refines: (node.getAttribute("refines") || "").trim(),
        properties: tokenizeProperties(node.getAttribute("properties") || "")
      });
    }
  }

  return result;
}

function parseGuideReferences(opfDoc, opfDir) {
  var guideNodes = byLocalName(opfDoc, "guide");
  if (!guideNodes.length) {
    return [];
  }

  var out = [];
  var referenceNodes = childrenByLocal(guideNodes[0], "reference");
  for (var i = 0; i < referenceNodes.length; i += 1) {
    var href = (referenceNodes[i].getAttribute("href") || "").trim();
    if (!href) {
      continue;
    }
    var ref = resolveTargetRef(opfDir, href);
    out.push({
      type: (referenceNodes[i].getAttribute("type") || "").trim(),
      title: (referenceNodes[i].getAttribute("title") || "").trim(),
      href: href,
      path: ref.path || "",
      fragment: ref.fragment || ""
    });
  }
  return out;
}

function parseBindings(opfDoc) {
  var bindingsNodes = byLocalName(opfDoc, "bindings");
  if (!bindingsNodes.length) {
    return [];
  }

  var out = [];
  var mediaTypeNodes = childrenByLocal(bindingsNodes[0], "mediaType");
  for (var i = 0; i < mediaTypeNodes.length; i += 1) {
    out.push({
      mediaType: (mediaTypeNodes[i].getAttribute("media-type") || "").trim(),
      handler: (mediaTypeNodes[i].getAttribute("handler") || "").trim()
    });
  }
  return out;
}

function parseCollections(opfDoc) {
  var collectionNodes = byLocalName(opfDoc, "collection");
  var out = [];
  for (var i = 0; i < collectionNodes.length; i += 1) {
    out.push({
      role: (collectionNodes[i].getAttribute("role") || "").trim(),
      id: (collectionNodes[i].getAttribute("id") || "").trim()
    });
  }
  return out;
}

function detectCover(manifest, metaNames, guideReferences, opfDir, resolver) {
  var foundByProperty = null;
  manifest.forEach(function (item) {
    if (foundByProperty) {
      return;
    }
    if (hasManifestProperty(item, "cover-image")) {
      foundByProperty = {
        type: "image",
        id: item.id,
        href: item.href,
        path: resolveManifestItemPath(item, opfDir, resolver),
        source: "manifest-properties-cover-image"
      };
    }
  });
  if (foundByProperty) {
    return foundByProperty;
  }

  for (var i = 0; i < metaNames.length; i += 1) {
    if (String(metaNames[i].name || "").toLowerCase() !== "cover") {
      continue;
    }
    var coverId = metaNames[i].content || "";
    if (!coverId || !manifest.has(coverId)) {
      continue;
    }
    var coverItem = manifest.get(coverId);
    return {
      type: "image",
      id: coverId,
      href: coverItem.href,
      path: resolveManifestItemPath(coverItem, opfDir, resolver),
      source: "meta-name-cover"
    };
  }

  for (var refIndex = 0; refIndex < guideReferences.length; refIndex += 1) {
    if (String(guideReferences[refIndex].type || "").toLowerCase() !== "cover") {
      continue;
    }
    return {
      type: "page",
      id: "",
      href: guideReferences[refIndex].href,
      path: guideReferences[refIndex].path,
      source: "guide-reference-cover"
    };
  }

  return null;
}

function tokenizeProperties(value) {
  var input = String(value || "").trim();
  if (!input) {
    return [];
  }
  return input.split(/\s+/).filter(Boolean);
}

function resolveManifestHref(opfDir, href, resolver) {
  var rawHref = String(href || "").trim();
  if (!rawHref) {
    return { path: "", isRemote: false, outOfContainer: false };
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawHref) || rawHref.indexOf("//") === 0) {
    return { path: "", isRemote: true, outOfContainer: false };
  }

  var candidates = [];
  var escaped = false;
  if (rawHref.indexOf("/") === 0) {
    var rootDetails = normalizePathDetails(rawHref.slice(1));
    if (rootDetails.outOfContainer) {
      escaped = true;
    }
    if (rootDetails.path) {
      candidates.push(rootDetails.path);
    }
    var compatRelative = resolveRelative(opfDir || "", rawHref.slice(1));
    if (compatRelative && candidates.indexOf(compatRelative) < 0) {
      candidates.push(compatRelative);
    }
  } else {
    var directRelative = resolveRelative(opfDir || "", rawHref);
    if (directRelative) {
      candidates.push(directRelative);
    } else {
      escaped = true;
    }
  }

  if (!candidates.length) {
    return { path: "", isRemote: false, outOfContainer: escaped };
  }

  if (resolver) {
    for (var i = 0; i < candidates.length; i += 1) {
      if (resolver.has(candidates[i])) {
        return { path: candidates[i], isRemote: false, outOfContainer: false };
      }
    }
  }

  return { path: candidates[0], isRemote: false, outOfContainer: escaped };
}

export async function parseToc(resolver, opfInfo, opfDir) {
  var manifest = opfInfo.manifest;
  var spineTocId = opfInfo.spineTocId;

  if (spineTocId && manifest.has(spineTocId)) {
    var tocItem = manifest.get(spineTocId);
    var ncxPath = resolveManifestItemPath(tocItem, opfDir, resolver);
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

  var ncxManifestItem = null;
  manifest.forEach(function (item) {
    if (ncxManifestItem) {
      return;
    }
    if ((item.mediaType || "").toLowerCase() === "application/x-dtbncx+xml") {
      ncxManifestItem = item;
    }
  });
  if (ncxManifestItem) {
    var fallbackNcxPath = resolveManifestItemPath(ncxManifestItem, opfDir, resolver);
    if (fallbackNcxPath && resolver.has(fallbackNcxPath)) {
      var fallbackNcxText = await resolver.readText(fallbackNcxPath);
      var fallbackNcxDoc = parseXml(fallbackNcxText);
      var fallbackNavMap = byLocalName(fallbackNcxDoc, "navMap")[0];
      if (fallbackNavMap) {
        return {
          source: "ncx",
          baseDir: dirname(fallbackNcxPath),
          items: parseNcxPoints(childrenByLocal(fallbackNavMap, "navPoint"))
        };
      }
    }
  }

  var navItem = null;
  manifest.forEach(function (item) {
    if (navItem) {
      return;
    }
    if (hasManifestProperty(item, "nav")) {
      navItem = item;
    }
  });

  if (navItem) {
    var navPath = resolveManifestItemPath(navItem, opfDir, resolver);
    if (resolver.has(navPath)) {
      var navText = await resolver.readText(navPath);
      var navDoc = parseXml(navText);
      var navData = parseNavigationDocument(navDoc);
      if (navData.toc.length) {
        return {
          source: "nav",
          baseDir: dirname(navPath),
          items: navData.toc,
          landmarks: navData.landmarks,
          pageList: navData.pageList,
          others: navData.others
        };
      }
    }
  }

  return {
    source: "spine-fallback",
    baseDir: opfDir,
    items: []
  };
}

function hasManifestProperty(item, token) {
  if (!item || !token) {
    return false;
  }
  if (item.propertiesSet && typeof item.propertiesSet.has === "function") {
    return item.propertiesSet.has(token);
  }
  return tokenizeProperties(item.properties || "").indexOf(token) >= 0;
}

function resolveManifestItemPath(item, opfDir, resolver) {
  if (!item) {
    return "";
  }
  if (item.resolvedPath && (!resolver || resolver.has(item.resolvedPath))) {
    return item.resolvedPath;
  }
  var resolved = resolveManifestHref(opfDir || "", item.href || "", resolver || null);
  if (resolved.path) {
    item.resolvedPath = resolved.path;
    item.isRemote = resolved.isRemote;
    item.outOfContainer = resolved.outOfContainer;
  }
  return resolved.path;
}

function parseNavigationDocument(doc) {
  var result = {
    toc: [],
    landmarks: [],
    pageList: [],
    others: {}
  };

  var navNodes = byLocalName(doc, "nav");
  for (var i = 0; i < navNodes.length; i += 1) {
    var navNode = navNodes[i];
    var navType = navTypeFromNode(navNode);
    var rootList = firstChildByLocal(navNode, ["ol", "ul"]) || byLocalName(navNode, "ol")[0] || byLocalName(navNode, "ul")[0];
    if (!rootList) {
      continue;
    }

    var parsedItems = parseNavList(rootList);
    if (navType === "toc") {
      result.toc = parsedItems;
      continue;
    }
    if (navType === "landmarks") {
      result.landmarks = parsedItems;
      continue;
    }
    if (navType === "page-list") {
      result.pageList = parsedItems;
      continue;
    }
    if (!result.others[navType]) {
      result.others[navType] = [];
    }
    result.others[navType] = result.others[navType].concat(parsedItems);
  }

  if (!result.toc.length) {
    var fallbackNav = pickTocNavNode(doc);
    if (fallbackNav) {
      var fallbackRootList = firstChildByLocal(fallbackNav, ["ol", "ul"]) || byLocalName(fallbackNav, "ol")[0] || byLocalName(fallbackNav, "ul")[0];
      if (fallbackRootList) {
        result.toc = parseNavList(fallbackRootList);
      }
    }
  }

  return result;
}

function navTypeFromNode(navNode) {
  var rawTypes = [];
  var epubType = navNode.getAttribute("epub:type") || "";
  if (epubType) {
    rawTypes = rawTypes.concat(epubType.split(/\s+/));
  }

  var role = navNode.getAttribute("role") || "";
  if (role) {
    rawTypes = rawTypes.concat(role.split(/\s+/));
  }

  var lowered = rawTypes
    .map(function (token) { return String(token || "").toLowerCase(); })
    .filter(Boolean);

  for (var i = 0; i < lowered.length; i += 1) {
    if (lowered[i] === "doc-toc" || lowered[i] === "toc") {
      return "toc";
    }
    if (lowered[i] === "doc-landmarks" || lowered[i] === "landmarks") {
      return "landmarks";
    }
    if (lowered[i] === "doc-pagelist" || lowered[i] === "page-list" || lowered[i] === "pagelist") {
      return "page-list";
    }
  }

  return lowered[0] || "other";
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
  var auditCollector = opts.auditCollector || null;

  var manifest = opfInfo.manifest;
  var spine = opfInfo.spineItems && opfInfo.spineItems.length ? opfInfo.spineItems : opfInfo.spine;
  var titleByPath = buildTocTitleMap(tocData.items, tocData.baseDir);
  var mediaTypeByPath = buildMediaTypeByPath(manifest, opfDir);
  var chapters = [];

  for (var i = 0; i < spine.length; i += 1) {
    onChapterStatus("Loading chapter " + (i + 1) + " / " + spine.length + " ...");
    var spineRef = spine[i];
    var idref = typeof spineRef === "string" ? spineRef : spineRef.idref;
    if (!idref || !manifest.has(idref)) {
      pushSpineAudit(auditCollector, {
        index: i,
        idref: idref,
        status: "missing-manifest-item"
      });
      continue;
    }
    var resolvedSpineItem = resolveSpineItemToRenderable(manifest, idref, opfDir, resolver);
    if (resolvedSpineItem.status !== "ok") {
      pushSpineAudit(auditCollector, {
        index: i,
        idref: idref,
        status: resolvedSpineItem.status,
        fallbackChain: resolvedSpineItem.chain
      });
      continue;
    }

    var item = resolvedSpineItem.item;
    var path = resolvedSpineItem.path;
    var chapterText = await resolver.readText(path);
    var bodyHtml = extractBodyMarkup(chapterText);
    if (!bodyHtml) {
      pushSpineAudit(auditCollector, {
        index: i,
        idref: idref,
        status: "empty-body",
        path: path,
        fallbackChain: resolvedSpineItem.chain
      });
      continue;
    }

    var heading = titleByPath.get(path) || extractFirstHeading(chapterText) || stripExt(path.split("/").pop() || ("chapter-" + (i + 1)));
    var sectionPrefix = "ch" + (i + 1);
    var prepared = await prepareChapterHtml(bodyHtml, sectionPrefix, resolver, dirname(path), mediaTypeByPath, mediaAssetRegistry, {
      chapterPath: path
    });

    if (auditCollector && prepared.resourceAudit && prepared.resourceAudit.length) {
      for (var resourceIndex = 0; resourceIndex < prepared.resourceAudit.length; resourceIndex += 1) {
        auditCollector.referencedResources.push(prepared.resourceAudit[resourceIndex]);
      }
    }

    chapters.push({
      index: i + 1,
      path: path,
      title: heading,
      html: prepared.html,
      idMap: prepared.idMap,
      sourceIdref: idref,
      resolvedManifestId: item.id
    });

    pushSpineAudit(auditCollector, {
      index: i,
      idref: idref,
      status: "rendered",
      path: path,
      resolvedManifestId: item.id,
      fallbackChain: resolvedSpineItem.chain
    });
  }

  return chapters;
}

function pushSpineAudit(auditCollector, entry) {
  if (!auditCollector || !auditCollector.spineItems) {
    return;
  }
  auditCollector.spineItems.push(entry);
}

function resolveSpineItemToRenderable(manifest, idref, opfDir, resolver) {
  var visited = new Set();
  var chain = [];
  var currentId = idref;
  var hasResolver = !!(resolver && typeof resolver.has === "function");

  while (currentId) {
    if (!manifest.has(currentId)) {
      return {
        status: "missing-manifest-item",
        chain: chain
      };
    }
    if (visited.has(currentId)) {
      return {
        status: "fallback-cycle",
        chain: chain
      };
    }

    visited.add(currentId);
    var item = manifest.get(currentId);
    var resolvedPath = resolveManifestItemPath(item, opfDir, resolver);
    var mediaType = (item.mediaType || "").toLowerCase();
    var exists = !!resolvedPath && (!hasResolver || resolver.has(resolvedPath));
    var htmlRenderable = exists && isHtmlLikeMedia(mediaType, resolvedPath);
    chain.push({
      id: currentId,
      path: resolvedPath,
      mediaType: mediaType,
      exists: exists,
      fallback: item.fallback || "",
      htmlRenderable: htmlRenderable,
      encrypted: !!item.encryption
    });

    if (item.isRemote) {
      return {
        status: "remote-resource",
        chain: chain
      };
    }

    if (item.outOfContainer) {
      return {
        status: "out-of-container",
        chain: chain
      };
    }

    if (item.encryption && !item.encryption.supported) {
      return {
        status: "encrypted-resource",
        chain: chain
      };
    }

    if (htmlRenderable) {
      return {
        status: "ok",
        item: item,
        path: resolvedPath,
        chain: chain
      };
    }

    if (!exists) {
      if (item.fallback) {
        currentId = item.fallback;
        continue;
      }
      return {
        status: "missing-resource",
        chain: chain
      };
    }

    if (item.fallback) {
      currentId = item.fallback;
      continue;
    }

    return {
      status: "unsupported-media-type",
      chain: chain
    };
  }

  return {
    status: "unresolved-spine-item",
    chain: chain
  };
}

function isHtmlLikeMedia(mediaType, path) {
  var lowerType = String(mediaType || "").toLowerCase();
  return lowerType.indexOf("xhtml") >= 0 || lowerType.indexOf("html") >= 0 || /\.x?html?$/i.test(path || "");
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
    var absoluteDetails = normalizePathDetails(hrefPath.slice(1));
    return absoluteDetails.outOfContainer ? "" : absoluteDetails.path;
  }
  var base = baseDir ? baseDir + "/" : "";
  var details = normalizePathDetails(base + hrefPath);
  return details.outOfContainer ? "" : details.path;
}

export function dirname(path) {
  var norm = normalizePath(path);
  var idx = norm.lastIndexOf("/");
  return idx < 0 ? "" : norm.slice(0, idx);
}

export function normalizePath(path) {
  return normalizePathDetails(path).path;
}

function normalizePathDetails(path) {
  var input = (path || "").replace(/\\/g, "/");
  var parts = input.split("/");
  var out = [];
  var escaped = false;
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i];
    if (!p || p === ".") {
      continue;
    }
    if (p === "..") {
      if (!out.length) {
        escaped = true;
        continue;
      }
      out.pop();
      continue;
    }
    out.push(p);
  }
  return {
    path: out.join("/"),
    outOfContainer: escaped
  };
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

async function prepareChapterHtml(rawHtml, prefix, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, options) {
  var opts = options || {};
  var parser = new DOMParser();
  var doc = parser.parseFromString("<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>", "text/html");
  var root = doc.getElementById("root");
  root.innerHTML = rawHtml;
  var resourceAudit = [];

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

  await rewriteEmbeddedMediaUrls(root, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, {
    chapterPath: opts.chapterPath || "",
    resourceAudit: resourceAudit
  });
  trimEmptyEdges(root, 12);

  return {
    html: root.innerHTML,
    idMap: idMap,
    resourceAudit: resourceAudit
  };
}

async function rewriteEmbeddedMediaUrls(root, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, options) {
  var opts = options || {};
  if (!root || !resolver) {
    return;
  }

  var attrTasks = [];
  var srcNodes = root.querySelectorAll("img[src],source[src],video[src],audio[src]");
  for (var i = 0; i < srcNodes.length; i += 1) {
    attrTasks.push(rewriteMediaAttr(srcNodes[i], "src", resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, opts));
  }

  var posterNodes = root.querySelectorAll("video[poster]");
  for (var j = 0; j < posterNodes.length; j += 1) {
    attrTasks.push(rewriteMediaAttr(posterNodes[j], "poster", resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, opts));
  }

  var svgImageNodes = root.querySelectorAll("image");
  for (var k = 0; k < svgImageNodes.length; k += 1) {
    attrTasks.push(rewriteSvgImageHref(svgImageNodes[k], resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, opts));
  }

  await Promise.all(attrTasks);

  var srcsetNodes = root.querySelectorAll("img[srcset],source[srcset]");
  for (var n = 0; n < srcsetNodes.length; n += 1) {
    var srcset = srcsetNodes[n].getAttribute("srcset") || "";
    var rewrittenSrcset = await rewriteSrcsetValue(srcset, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, opts);
    if (rewrittenSrcset) {
      srcsetNodes[n].setAttribute("srcset", rewrittenSrcset);
    }
  }
}

async function rewriteMediaAttr(node, attrName, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, auditOptions) {
  if (!node || !attrName) {
    return;
  }

  var raw = (node.getAttribute(attrName) || "").trim();
  if (!raw) {
    return;
  }

  var result = await resolveEmbeddedMedia(raw, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry);
  pushReferencedResourceAudit(auditOptions, {
    chapterPath: auditOptions && auditOptions.chapterPath ? auditOptions.chapterPath : "",
    element: localName(node),
    attribute: attrName,
    raw: raw,
    path: result.path,
    status: result.status
  });
  if (result.url) {
    node.setAttribute(attrName, result.url);
  }
}

async function rewriteSvgImageHref(node, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, auditOptions) {
  if (!node) {
    return;
  }

  var rawHref = (node.getAttribute("href") || node.getAttribute("xlink:href") || "").trim();
  if (!rawHref && typeof node.getAttributeNS === "function") {
    rawHref = (node.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "").trim();
  }
  if (!rawHref) {
    return;
  }

  var result = await resolveEmbeddedMedia(rawHref, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry);
  pushReferencedResourceAudit(auditOptions, {
    chapterPath: auditOptions && auditOptions.chapterPath ? auditOptions.chapterPath : "",
    element: "image",
    attribute: "href",
    raw: rawHref,
    path: result.path,
    status: result.status
  });
  if (!result.url) {
    return;
  }

  node.setAttribute("href", result.url);
  node.setAttribute("xlink:href", result.url);
  if (typeof node.setAttributeNS === "function") {
    try {
      node.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", result.url);
    } catch (_error) {
      // Some runtimes may not support writing namespaced attrs for HTML-parsed SVG nodes.
    }
  }
}

async function rewriteSrcsetValue(value, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry, auditOptions) {
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
    var result = await resolveEmbeddedMedia(urlPart, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry);
    pushReferencedResourceAudit(auditOptions, {
      chapterPath: auditOptions && auditOptions.chapterPath ? auditOptions.chapterPath : "",
      element: "source",
      attribute: "srcset",
      raw: urlPart,
      path: result.path,
      status: result.status
    });

    if (!result.url) {
      out.push(token);
      continue;
    }
    out.push(descriptor ? result.url + " " + descriptor : result.url);
  }

  return out.join(", ");
}

async function resolveEmbeddedMedia(rawUrl, resolver, chapterDir, mediaTypeByPath, mediaAssetRegistry) {
  var parsed = splitResourceUrl(rawUrl || "");
  if (!parsed.path) {
    return {
      url: "",
      path: "",
      status: "empty-path"
    };
  }

  var classification = classifyResourcePath(parsed.path);
  if (classification !== "local") {
    return {
      url: "",
      path: "",
      status: classification
    };
  }

  var resolvedPath = resolveRelative(chapterDir || "", parsed.path);
  if (!resolvedPath) {
    return {
      url: "",
      path: "",
      status: "out-of-container"
    };
  }
  if (!resolver.has(resolvedPath)) {
    return {
      url: "",
      path: resolvedPath,
      status: "missing-resource"
    };
  }

  var mediaUrl = await getOrCreateMediaAssetUrl(mediaAssetRegistry, resolver, resolvedPath, mediaTypeByPath);
  if (!mediaUrl) {
    return {
      url: "",
      path: resolvedPath,
      status: "missing-resource"
    };
  }

  return {
    url: mediaUrl + parsed.suffix,
    path: resolvedPath,
    status: "resolved"
  };
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

function classifyResourcePath(path) {
  var value = (path || "").trim().toLowerCase();
  if (!value) {
    return "empty-path";
  }
  if (value.indexOf("//") === 0) {
    return "protocol-relative";
  }
  if (value.indexOf("data:") === 0) {
    return "data-uri";
  }
  if (value.indexOf("blob:") === 0) {
    return "blob-uri";
  }
  if (value.indexOf("#") === 0) {
    return "hash-only";
  }
  if (value.indexOf("file:") === 0) {
    return "blocked-file-scheme";
  }
  if (value.indexOf("http:") === 0 || value.indexOf("https:") === 0) {
    return "remote-resource";
  }
  if (/^[a-z][a-z0-9+.-]*:/.test(value)) {
    return "unsupported-scheme";
  }
  return "local";
}

function pushReferencedResourceAudit(auditOptions, entry) {
  if (!auditOptions || !auditOptions.resourceAudit) {
    return;
  }
  auditOptions.resourceAudit.push(entry);
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
    var path = resolveManifestItemPath(item, opfDir || "", null);
    if (!path) {
      return;
    }
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
