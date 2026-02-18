import { cleanText, localName } from "./parser.js";

export function removeDuplicateLeadingHeading(html, title) {
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

  if (tryRemoveLeadingTitleCluster(body, normalizedTitle)) {
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

function tryRemoveLeadingTitleCluster(body, normalizedTitle) {
  var candidates = collectLeadingTitleCandidates(body, 2);
  if (!candidates.length) {
    return false;
  }

  var firstText = normalizeHeadingCompare(candidates[0].textContent || "");
  if (!firstText) {
    return false;
  }

  if (firstText === normalizedTitle) {
    removeNodesAndCleanup(body, [candidates[0]]);
    return true;
  }

  if (candidates.length < 2) {
    return false;
  }

  var secondText = normalizeHeadingCompare(candidates[1].textContent || "");
  if (!secondText) {
    return false;
  }

  if (firstText + secondText === normalizedTitle) {
    removeNodesAndCleanup(body, [candidates[0], candidates[1]]);
    return true;
  }

  return false;
}

function collectLeadingTitleCandidates(body, maxCount) {
  var out = [];
  var node = body.firstElementChild;

  while (node && out.length < maxCount) {
    if (isEmptyNode(node)) {
      node = node.nextElementSibling;
      continue;
    }
    if (!isDuplicateTitleCandidate(node)) {
      break;
    }
    if (hasMeaningfulContentBeforeNode(body, node)) {
      break;
    }

    out.push(node);
    node = node.nextElementSibling;
  }

  return out;
}

function removeNodesAndCleanup(body, nodes) {
  for (var i = 0; i < nodes.length; i += 1) {
    if (!nodes[i] || !nodes[i].parentElement) {
      continue;
    }
    var parent = nodes[i].parentElement;
    nodes[i].remove();
    cleanupEmptyContainerUpwards(parent, body);
  }
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
