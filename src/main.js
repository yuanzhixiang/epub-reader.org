import {
  buildSpineFallbackToc,
  cleanText,
  createMediaAssetRegistry,
  dirname,
  findChapterPathByFragment,
  humanizeTocSource,
  localName,
  normalizePath,
  parseEpubFromArrayBuffer,
  resolveTargetRef,
  slugify,
  stripExt
} from "./epub/parser.js";

(function () {
  var fileInput = document.getElementById("fileInput");
  var dropZone = document.getElementById("dropZone");
  var startScreen = document.getElementById("startScreen");
  var viewerLayout = document.getElementById("viewerLayout");
  var tocWrap = document.getElementById("tocWrap");
  var mainPanel = document.getElementById("mainPanel");
  var statusEl = document.getElementById("statusInline");
  var contentBody = document.getElementById("contentBody");

  var isLoading = false;
  var activeTocLink = null;
  var contentSelectMode = false;
  var allChaptersByPath = new Map();
  var allIdMapByPath = new Map();
  var renderedSectionByPath = new Map();
  var mediaAssetRegistry = createMediaAssetRegistry();

  fileInput.addEventListener("change", function (event) {
    var file = event.target.files && event.target.files[0];
    if (file) {
      loadEpub(file);
    }
  });

  dropZone.addEventListener("dragover", function (event) {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", function (event) {
    event.preventDefault();
    dropZone.classList.remove("dragover");
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
      loadEpub(file);
    }
  });

  document.addEventListener("pointerdown", function (event) {
    if (!viewerLayout || viewerLayout.hidden || !mainPanel) {
      return;
    }
    if (mainPanel.contains(event.target)) {
      contentSelectMode = true;
      if (typeof mainPanel.focus === "function") {
        mainPanel.focus({ preventScroll: true });
      }
    } else {
      contentSelectMode = false;
    }
  });

  document.addEventListener("keydown", function (event) {
    if (!isSelectAllShortcut(event)) {
      return;
    }
    if (!viewerLayout || viewerLayout.hidden || !contentSelectMode) {
      return;
    }
    if (isEditableElement(event.target)) {
      return;
    }
    event.preventDefault();
    selectContentArea(contentBody);
  });

  contentBody.addEventListener("click", handleContentLinkClick);

  async function loadEpub(file) {
    if (isLoading) {
      return;
    }

    isLoading = true;
    setLoadingState(true);

    try {
      assertJsZipLoaded();
      setStatus("Reading file...");
      mediaAssetRegistry.revokeAll();
      clearRender();

      var buffer = await file.arrayBuffer();
      var parsed = await parseEpubFromArrayBuffer(buffer, {
        jszip: window.JSZip,
        onStatus: setStatus,
        mediaAssetRegistry: mediaAssetRegistry
      });

      var title = parsed.title || file.name.replace(/\.epub$/i, "");
      document.title = title + " - EPUB Memory Viewer";

      var tocData = parsed.tocData;
      var chapters = parsed.chapters;
      if (chapters.length === 0) {
        throw new Error("No displayable chapters found (empty spine or missing chapter files).");
      }

      cacheChapterState(chapters);
      setStatus("Rendering page...");
      var sectionMaps = renderChapters(chapters);
      renderToc(tocData, chapters, sectionMaps);

      setStatus(
        "Done: " +
        chapters.length +
        " chapters, TOC source: " +
        humanizeTocSource(tocData.source) +
        ". Click a TOC item to show that node and its children."
      );
      enterViewerMode();
    } catch (error) {
      mediaAssetRegistry.revokeAll();
      document.title = "EPUB Memory Viewer";
      setStatus(error && error.message ? error.message : String(error));
      tocWrap.innerHTML = "<div class=\"placeholder\">TOC parsing failed.</div>";
      contentBody.innerHTML = "<div class=\"placeholder\">Content parsing failed. Please check the EPUB structure.</div>";
      if (window.console && window.console.error) {
        window.console.error(error);
      }
      exitViewerMode();
    } finally {
      isLoading = false;
      setLoadingState(false);
    }
  }

  function setLoadingState(flag) {
    fileInput.disabled = !!flag;
    if (flag) {
      dropZone.classList.add("dragover");
    } else {
      dropZone.classList.remove("dragover");
    }
  }

  function enterViewerMode() {
    if (startScreen) {
      startScreen.hidden = true;
    }
    if (viewerLayout) {
      viewerLayout.hidden = false;
    }
    contentSelectMode = true;
  }

  function exitViewerMode() {
    if (viewerLayout) {
      viewerLayout.hidden = true;
    }
    if (startScreen) {
      startScreen.hidden = false;
    }
    contentSelectMode = false;
  }

  function isSelectAllShortcut(event) {
    if (!event) {
      return false;
    }
    var key = (event.key || "").toLowerCase();
    return (event.metaKey || event.ctrlKey) && !event.altKey && key === "a";
  }

  function isEditableElement(target) {
    if (!target || typeof target.closest !== "function") {
      return false;
    }
    return !!target.closest("input, textarea, select, [contenteditable], [contenteditable='plaintext-only']");
  }

  function selectContentArea(container) {
    if (!container || !window.getSelection || !document.createRange) {
      return;
    }
    var selection = window.getSelection();
    if (!selection) {
      return;
    }
    var range = document.createRange();
    range.selectNodeContents(container);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function assertJsZipLoaded() {
    if (!window.JSZip) {
      throw new Error("JSZip failed to load. Check your network and retry.");
    }
  }

  function setStatus(message) {
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function clearRender() {
    activeTocLink = null;
    renderedSectionByPath = new Map();
    allChaptersByPath = new Map();
    allIdMapByPath = new Map();
    tocWrap.innerHTML = "<div class=\"placeholder\">Building table of contents...</div>";
    contentBody.innerHTML = "<div class=\"placeholder\">Building full content...</div>";
  }

  function cacheChapterState(chapters) {
    allChaptersByPath = new Map();
    allIdMapByPath = new Map();
    for (var i = 0; i < chapters.length; i += 1) {
      var chapter = chapters[i];
      allChaptersByPath.set(chapter.path, chapter);
      allIdMapByPath.set(chapter.path, chapter.idMap || new Map());
    }
  }

  function renderChapters(chapters) {
    contentBody.innerHTML = "";
    var sectionByPath = new Map();
    var idMapByPath = new Map();

    for (var i = 0; i < chapters.length; i += 1) {
      var chapter = chapters[i];
      var sectionId = "section-" + chapter.index;
      var displayTitle = chapter.title || stripExt(chapter.path.split("/").pop() || ("chapter-" + chapter.index));

      var article = document.createElement("article");
      article.className = "chapter";
      article.id = sectionId;
      article.setAttribute("data-chapter-path", chapter.path);

      var h2 = document.createElement("h2");
      h2.textContent = displayTitle;
      article.appendChild(h2);

      var content = document.createElement("div");
      content.className = "chapter-content";
      content.setAttribute("data-chapter-path", chapter.path);
      content.innerHTML = removeDuplicateLeadingHeading(chapter.html, displayTitle);
      article.appendChild(content);

      contentBody.appendChild(article);
      sectionByPath.set(chapter.path, sectionId);
      idMapByPath.set(chapter.path, chapter.idMap);
    }

    renderedSectionByPath = sectionByPath;

    return {
      sectionByPath: sectionByPath,
      idMapByPath: idMapByPath
    };
  }

  function renderToc(tocData, chapters, maps) {
    var items = tocData.items && tocData.items.length ? tocData.items : buildSpineFallbackToc(chapters);
    if (!items.length) {
      tocWrap.innerHTML = "<div class=\"placeholder\">No table of contents generated.</div>";
      return;
    }

    activeTocLink = null;
    tocWrap.innerHTML = "";
    var tree = document.createElement("ul");
    tree.className = "toc-tree";
    tocWrap.appendChild(tree);

    var chapterByPath = new Map();
    var spinePaths = [];
    var spineIndexByPath = new Map();
    for (var i = 0; i < chapters.length; i += 1) {
      var chapterPath = chapters[i].path;
      chapterByPath.set(chapterPath, chapters[i]);
      spinePaths.push(chapterPath);
      spineIndexByPath.set(chapterPath, i);
    }

    renderTocBranch(
      items,
      tree,
      tocData.baseDir || "",
      maps.sectionByPath,
      maps.idMapByPath,
      chapterByPath,
      spinePaths,
      spineIndexByPath,
      ""
    );
  }

  function renderTocBranch(items, parentEl, tocBaseDir, sectionByPath, idMapByPath, chapterByPath, spinePaths, spineIndexByPath, fallbackBoundaryPath) {
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var nextBoundaryPath = findNextBoundaryPath(items, i, tocBaseDir, sectionByPath, idMapByPath, fallbackBoundaryPath);
      var li = document.createElement("li");
      var row = document.createElement("div");
      row.className = "toc-row";

      var link = document.createElement("a");
      link.textContent = item.title || "Untitled";
      var refs = collectChapterRefsFromItem(
        item,
        tocBaseDir,
        sectionByPath,
        idMapByPath,
        spinePaths,
        spineIndexByPath,
        nextBoundaryPath
      );
      if (refs.length > 0) {
        link.href = "javascript:void(0)";
        attachTocSelectHandler(link, item, refs, chapterByPath);
      } else {
        link.href = "javascript:void(0)";
        link.classList.add("disabled");
      }

      row.appendChild(link);
      li.appendChild(row);

      if (item.children && item.children.length) {
        var child = document.createElement("ul");
        child.className = "toc-tree";
        li.appendChild(child);
        renderTocBranch(
          item.children,
          child,
          tocBaseDir,
          sectionByPath,
          idMapByPath,
          chapterByPath,
          spinePaths,
          spineIndexByPath,
          nextBoundaryPath
        );
      }

      parentEl.appendChild(li);
    }
  }

  function attachTocSelectHandler(link, item, refs, chapterByPath) {
    link.addEventListener("click", function (event) {
      event.preventDefault();

      if (activeTocLink && activeTocLink !== link) {
        activeTocLink.classList.remove("active");
      }
      activeTocLink = link;
      link.classList.add("active");

      renderSelectedChapters(refs, chapterByPath);
      var chapterCount = 0;
      for (var i = 0; i < refs.length; i += 1) {
        if (!refs[i].continuation) {
          chapterCount += 1;
        }
      }
      setStatus("Showing: " + (item.title || "Untitled") + " (" + chapterCount + " chapters)");
    });
  }

  function renderSelectedChapters(refs, chapterByPath, options) {
    contentBody.innerHTML = "";

    var rendered = 0;
    var sectionByPath = new Map();
    for (var i = 0; i < refs.length; i += 1) {
      var ref = refs[i];
      var chapter = chapterByPath.get(ref.path);
      if (!chapter) {
        continue;
      }
      var displayTitle = ref.title || chapter.title || stripExt(ref.path.split("/").pop() || ref.path);
      var isContinuation = !!ref.continuation;

      var article = document.createElement("article");
      article.className = "chapter";
      article.id = "selected-" + slugify(chapter.path) + "-" + i;
      article.setAttribute("data-chapter-path", chapter.path);

      if (!isContinuation) {
        var h2 = document.createElement("h2");
        h2.textContent = displayTitle;
        article.appendChild(h2);
      }

      var content = document.createElement("div");
      content.className = "chapter-content";
      content.setAttribute("data-chapter-path", chapter.path);
      content.innerHTML = removeDuplicateLeadingHeading(chapter.html, isContinuation ? "" : displayTitle);
      article.appendChild(content);

      contentBody.appendChild(article);
      sectionByPath.set(chapter.path, article.id);
      rendered += 1;
    }

    renderedSectionByPath = sectionByPath;

    if (!rendered) {
      contentBody.innerHTML = "<div class=\"placeholder\">No displayable chapter content under this node.</div>";
    }

    if (!options || !options.skipTopScroll) {
      var panel = contentBody.parentElement;
      if (panel && typeof panel.scrollTo === "function") {
        panel.scrollTo({ top: 0, behavior: "smooth" });
      } else if (panel) {
        panel.scrollTop = 0;
      }
    }
  }

  function handleContentLinkClick(event) {
    if (!event || event.defaultPrevented || event.button !== 0) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (!event.target || typeof event.target.closest !== "function") {
      return;
    }

    var link = event.target.closest("a[href]");
    if (!link || !contentBody.contains(link)) {
      return;
    }

    var href = (link.getAttribute("href") || "").trim();
    if (!href) {
      return;
    }
    if ((link.getAttribute("target") || "").toLowerCase() === "_blank") {
      return;
    }

    var sourcePath = "";
    var contentNode = link.closest(".chapter-content[data-chapter-path]");
    if (contentNode) {
      sourcePath = contentNode.getAttribute("data-chapter-path") || "";
    }

    var ref = resolveTargetRef(dirname(sourcePath), href);
    if (ref.external) {
      return;
    }

    event.preventDefault();

    var targetPath = normalizePath(ref.path || sourcePath || "");
    var targetFragment = ref.fragment || "";
    if (targetPath && targetFragment) {
      var idMap = allIdMapByPath.get(targetPath);
      if (idMap && idMap.has(targetFragment)) {
        targetFragment = idMap.get(targetFragment);
      }
    }

    if (!targetPath && targetFragment) {
      targetPath = findChapterPathByFragment(targetFragment, allIdMapByPath);
    }

    if (!targetPath && !targetFragment) {
      return;
    }

    if (targetPath && !renderedSectionByPath.has(targetPath) && allChaptersByPath.has(targetPath)) {
      var chapter = allChaptersByPath.get(targetPath);
      renderSelectedChapters(
        [{ path: targetPath, title: chapter.title || "" }],
        allChaptersByPath,
        { skipTopScroll: true }
      );
      if (activeTocLink) {
        activeTocLink.classList.remove("active");
        activeTocLink = null;
      }
    }

    if (!scrollToContentTarget(targetPath, targetFragment)) {
      setStatus("Cannot locate link target: " + href);
    }
  }

  function scrollToContentTarget(path, fragment) {
    var targetSection = path ? renderedSectionByPath.get(path) : "";
    var sectionEl = targetSection ? document.getElementById(targetSection) : null;
    if (!sectionEl) {
      return false;
    }

    var targetEl = sectionEl;
    if (fragment) {
      var fragmentEl = document.getElementById(fragment);
      if (fragmentEl && sectionEl.contains(fragmentEl)) {
        targetEl = fragmentEl;
      }
    }

    if (typeof targetEl.scrollIntoView === "function") {
      targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (mainPanel) {
      mainPanel.scrollTop = targetEl.offsetTop || 0;
    }
    return true;
  }

  function findNextBoundaryPath(items, index, tocBaseDir, sectionByPath, idMapByPath, fallbackBoundaryPath) {
    for (var i = index + 1; i < items.length; i += 1) {
      var nextPath = findFirstChapterPathInItem(items[i], tocBaseDir, sectionByPath, idMapByPath);
      if (nextPath) {
        return nextPath;
      }
    }
    return fallbackBoundaryPath || "";
  }

  function findFirstChapterPathInItem(item, tocBaseDir, sectionByPath, idMapByPath) {
    var path = "";
    walk(item);
    return path;

    function walk(node) {
      if (!node || path) {
        return;
      }

      var nodePath = resolveChapterPathFromTocNode(node, tocBaseDir, sectionByPath, idMapByPath);
      if (nodePath) {
        path = nodePath;
        return;
      }

      var children = node.children || [];
      for (var i = 0; i < children.length; i += 1) {
        walk(children[i]);
      }
    }
  }

  function collectAnchorRefsFromItem(rootItem, tocBaseDir, sectionByPath, idMapByPath) {
    var refs = [];
    var seen = new Set();

    walk(rootItem);
    return refs;

    function walk(node) {
      if (!node) {
        return;
      }

      var path = resolveChapterPathFromTocNode(node, tocBaseDir, sectionByPath, idMapByPath);
      if (path && !seen.has(path)) {
        seen.add(path);
        refs.push({
          path: path,
          title: cleanText(node.title || ""),
          continuation: false
        });
      }

      var children = node.children || [];
      for (var i = 0; i < children.length; i += 1) {
        walk(children[i]);
      }
    }
  }

  function resolveChapterPathFromTocNode(node, tocBaseDir, sectionByPath, idMapByPath) {
    if (!node) {
      return "";
    }
    var ref = resolveTargetRef(tocBaseDir, node.href || "");
    if (ref.external) {
      return "";
    }
    if (ref.path && sectionByPath.has(ref.path)) {
      return ref.path;
    }
    if (!ref.path && ref.fragment) {
      return findChapterPathByFragment(ref.fragment, idMapByPath);
    }
    return "";
  }

  function collectChapterRefsFromItem(rootItem, tocBaseDir, sectionByPath, idMapByPath, spinePaths, spineIndexByPath, boundaryPath) {
    var anchorRefs = collectAnchorRefsFromItem(rootItem, tocBaseDir, sectionByPath, idMapByPath);
    if (!anchorRefs.length) {
      return [];
    }
    if (!spinePaths || !spinePaths.length || !spineIndexByPath) {
      return anchorRefs;
    }

    var stopIdx = spinePaths.length;
    if (boundaryPath && spineIndexByPath.has(boundaryPath)) {
      stopIdx = spineIndexByPath.get(boundaryPath);
    }

    var refs = [];
    var seen = new Set();

    for (var i = 0; i < anchorRefs.length; i += 1) {
      var anchor = anchorRefs[i];
      if (!spineIndexByPath.has(anchor.path)) {
        continue;
      }

      var startIdx = spineIndexByPath.get(anchor.path);
      if (startIdx >= stopIdx) {
        continue;
      }

      var endIdx = stopIdx;
      for (var j = i + 1; j < anchorRefs.length; j += 1) {
        var nextAnchorPath = anchorRefs[j].path;
        if (spineIndexByPath.has(nextAnchorPath)) {
          endIdx = Math.min(endIdx, spineIndexByPath.get(nextAnchorPath));
          break;
        }
      }

      if (endIdx <= startIdx) {
        endIdx = Math.min(stopIdx, startIdx + 1);
      }

      for (var k = startIdx; k < endIdx && k < spinePaths.length; k += 1) {
        var path = spinePaths[k];
        if (seen.has(path)) {
          continue;
        }
        seen.add(path);
        refs.push({
          path: path,
          title: k === startIdx ? anchor.title : "",
          continuation: k !== startIdx
        });
      }
    }

    if (!refs.length) {
      return anchorRefs;
    }
    return refs;
  }

  function removeDuplicateLeadingHeading(html, title) {
    var source = html || "";
    if (!source) {
      return "";
    }

    var normalizedTitle = normalizeHeadingCompare(title);
    if (!normalizedTitle) {
      return source;
    }

    var parser = new DOMParser();
    var doc = parser.parseFromString("<!doctype html><html><body>" + source + "</body></html>", "text/html");
    var body = doc.body;
    if (!body) {
      return source;
    }

    var first = body.firstElementChild;
    while (first && isEmptyNode(first)) {
      var next = first.nextElementSibling;
      first.remove();
      first = next;
    }

    if (!first) {
      return body.innerHTML;
    }

    var titleCandidates = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,div");
    if (!titleCandidates.length) {
      return body.innerHTML;
    }

    for (var i = 0; i < titleCandidates.length; i += 1) {
      var candidate = titleCandidates[i];
      if (!isDuplicateTitleCandidate(candidate)) {
        continue;
      }

      var normalizedCandidate = normalizeHeadingCompare(candidate.textContent || "");
      if (!normalizedCandidate || normalizedCandidate !== normalizedTitle) {
        continue;
      }

      if (!hasMeaningfulContentBeforeNode(body, candidate)) {
        var parent = candidate.parentElement;
        candidate.remove();
        cleanupEmptyContainerUpwards(parent, body);
        break;
      }
    }

    return body.innerHTML;
  }

  function hasMeaningfulContentBeforeNode(root, targetNode) {
    var treeDoc = root && root.ownerDocument ? root.ownerDocument : document;
    if (!root || !targetNode || !treeDoc || !treeDoc.createTreeWalker || !window.NodeFilter) {
      return false;
    }

    var walker = treeDoc.createTreeWalker(
      root,
      window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT,
      null
    );

    var node = walker.nextNode();
    while (node) {
      if (node === targetNode) {
        return false;
      }

      if (node.nodeType === 3) {
        if ((node.nodeValue || "").replace(/\u00a0/g, "").trim()) {
          if (isIgnorableLeadingTextNode(node, root, targetNode)) {
            node = walker.nextNode();
            continue;
          }
          return true;
        }
      } else if (node.nodeType === 1) {
        var tag = localName(node);
        if (["img", "svg", "video", "audio", "table", "ul", "ol", "blockquote", "pre", "code", "hr"].indexOf(tag) >= 0) {
          return true;
        }
      }

      node = walker.nextNode();
    }

    return false;
  }

  function isIgnorableLeadingTextNode(textNode, root, targetNode) {
    if (!textNode || textNode.nodeType !== 3) {
      return false;
    }

    var parent = textNode.parentElement;
    while (parent && parent !== root) {
      if (parent === targetNode || isHeadingElement(parent) || isChapterMarkerElement(parent)) {
        return true;
      }
      parent = parent.parentElement;
    }

    return false;
  }

  function isHeadingElement(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    return /^h[1-6]$/.test(localName(node));
  }

  function isChapterMarkerElement(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }

    var tag = localName(node);
    if (["p", "div", "span"].indexOf(tag) < 0 && !isHeadingElement(node)) {
      return false;
    }

    var text = cleanText(node.textContent || "");
    if (!text || text.length > 80) {
      return false;
    }

    var upper = text.toUpperCase();
    if (/^(CHAPTER|PART|BOOK|SECTION)\s+([0-9IVXLCDM]+|[A-Z]+)$/.test(upper)) {
      return true;
    }
    if (/^(CHAPTER|PART|BOOK|SECTION)\s+[0-9IVXLCDM]+[\s:.-]+/.test(upper) && text.length <= 40) {
      return true;
    }
    return false;
  }

  function isDuplicateTitleCandidate(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }

    var tag = localName(node);
    if (/^h[1-6]$/.test(tag)) {
      return true;
    }
    if (["p", "div"].indexOf(tag) < 0) {
      return false;
    }
    if (node.querySelector("img,svg,video,audio,table,ul,ol,blockquote,pre,code")) {
      return false;
    }

    var text = cleanText(node.textContent || "");
    if (!text || text.length > 160) {
      return false;
    }

    return true;
  }

  function cleanupEmptyContainerUpwards(node, stopNode) {
    var current = node;
    while (current && current !== stopNode) {
      if (!isEmptyNode(current)) {
        break;
      }
      var parent = current.parentElement;
      current.remove();
      current = parent;
    }
  }

  function normalizeHeadingCompare(text) {
    var value = cleanText(text || "").toLowerCase();
    value = value.replace(/["'`“”‘’]+/g, "");
    value = value.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
    return value;
  }

  function isEmptyNode(node) {
    if (!node || node.nodeType !== 1) {
      return true;
    }
    if (node.querySelector("img,svg,video,audio,table,ul,ol,blockquote,pre,code")) {
      return false;
    }
    var txt = (node.textContent || "").replace(/\u00a0/g, "").trim();
    return txt.length === 0;
  }
})();
