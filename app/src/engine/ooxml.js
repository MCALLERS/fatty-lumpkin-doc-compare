'use strict';
/**
 * Low-level OOXML / WordprocessingML helpers.
 * Thin, dependency-light wrappers over @xmldom/xmldom so the rest of the engine
 * can read and build Word XML without drowning in namespace boilerplate.
 */

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  xml: 'http://www.w3.org/XML/1998/namespace',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
};

/** Local name of a node, namespace-agnostic (`w:p` -> `p`). */
function local(node) {
  if (!node) return '';
  if (node.localName) return node.localName;
  const n = node.nodeName || '';
  const i = n.indexOf(':');
  return i === -1 ? n : n.slice(i + 1);
}

/** True when `node` is a w:-namespaced element with the given local name. */
function isW(node, name) {
  return !!node && node.nodeType === 1 && node.namespaceURI === NS.w && local(node) === name;
}

/** Direct element children, optionally filtered to a set of w: local names. */
function kids(node, ...names) {
  const out = [];
  if (!node) return out;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    if (!names.length || names.includes(local(c))) out.push(c);
  }
  return out;
}

/** First direct child element with the given w: local name. */
function kid(node, name) {
  for (let c = node && node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && local(c) === name) return c;
  }
  return null;
}

/** All descendants (depth-first) with the given w: local name. */
function descendants(node, name) {
  const out = [];
  (function walk(n) {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (local(c) === name) out.push(c);
      walk(c);
    }
  })(node);
  return out;
}

/** Read a w:-namespaced attribute (`wAttr(el, 'val')`). */
function wAttr(node, name) {
  if (!node || node.nodeType !== 1) return null;
  const v = node.getAttributeNS ? node.getAttributeNS(NS.w, name) : null;
  if (v !== null && v !== '') return v;
  const direct = node.getAttribute ? node.getAttribute('w:' + name) : null;
  return direct === '' ? null : direct;
}

function setWAttr(node, name, value) {
  node.setAttributeNS(NS.w, 'w:' + name, String(value));
}

/** Create a `w:`-prefixed element in the given document. */
function mk(doc, name, attrs) {
  const e = doc.createElementNS(NS.w, 'w:' + name);
  if (attrs) for (const [k, v] of Object.entries(attrs)) setWAttr(e, k, v);
  return e;
}

/** Create a `<w:t xml:space="preserve">` run-text node. */
function mkText(doc, tag, text) {
  const t = doc.createElementNS(NS.w, 'w:' + tag);
  t.setAttributeNS(NS.xml, 'xml:space', 'preserve');
  t.appendChild(doc.createTextNode(text));
  return t;
}

/** Remove a node from its parent (no-op if detached). */
function drop(node) {
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

/** Replace `node` with its own element children, in place. */
function unwrap(node) {
  const parent = node.parentNode;
  if (!parent) return;
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
}

/** Insert `node` immediately after `ref`. */
function after(ref, node) {
  const parent = ref.parentNode;
  if (ref.nextSibling) parent.insertBefore(node, ref.nextSibling);
  else parent.appendChild(node);
}

/** Concatenated visible text of a node (w:t + w:delText + tabs/breaks). */
function textOf(node) {
  let s = '';
  (function walk(n) {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) continue;
      const ln = local(c);
      if (ln === 't' || ln === 'delText') s += c.textContent || '';
      else if (ln === 'tab') s += '\t';
      else if (ln === 'br' || ln === 'cr') s += '\n';
      else if (ln === 'noBreakHyphen') s += '-';
      else walk(c);
    }
  })(node);
  return s;
}

module.exports = {
  NS, local, isW, kids, kid, descendants,
  wAttr, setWAttr, mk, mkText, drop, unwrap, after, textOf,
};
