// Shared config tree. Both the XML and the YAML front-ends produce this shape, mirroring what
// ClickHouse's ConfigProcessor sees after YAMLParser converts YAML to an XML DOM.

import * as YAML from '../vendor/yaml.min.mjs';

export function makeNode(name, line, col) {
  return {
    name,
    attrs: new Map(),     // name -> { value, line, col }
    children: [],
    comments: [],
    text: null,           // leaf text (raw, untrimmed) or null when the node has children
    textLine: line,
    line,
    col,
    endLine: line,
    parent: null,
  };
}

export function pathOf(node) {
  const parts = [];
  for (let n = node; n && n.parent; n = n.parent) parts.unshift(n.name);
  return parts;
}

export function childrenNamed(node, name) {
  return node.children.filter((c) => c.name === name);
}

export function child(node, name) {
  return node.children.find((c) => c.name === name) || null;
}

export function textOf(node) {
  return node && node.text != null ? node.text.trim() : null;
}

export function walk(node, fn, depth = 0) {
  fn(node, depth);
  for (const c of node.children) walk(c, fn, depth + 1);
}

/** Resolve a dotted path below `root` (first match per segment, like Poco's AbstractConfiguration). */
export function getPath(root, dotted) {
  let cur = root;
  for (const seg of dotted.split('.')) {
    cur = cur && child(cur, seg);
    if (!cur) return null;
  }
  return cur;
}

export class YamlError extends Error {
  constructor(message, line, col) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

/**
 * Parse YAML and convert it into the config tree following src/Common/Config/YAMLParser.cpp:
 *  - the document is always wrapped into a synthetic <clickhouse> root;
 *  - map keys become elements, "@key" scalars become attributes, "#text" becomes element text;
 *  - a sequence repeats its parent element once per item.
 */
export function parseYaml(src) {
  const lineCounter = new YAML.LineCounter();
  const ydoc = YAML.parseDocument(src, { lineCounter, uniqueKeys: false, prettyErrors: false, keepSourceTokens: true, merge: false });
  const pos = (range) => {
    if (!range) return { line: 1, col: 1 };
    const p = lineCounter.linePos(range[0]);
    return { line: p.line, col: p.col };
  };
  if (ydoc.errors.length) {
    const e = ydoc.errors[0];
    const p = e.linePos ? e.linePos[0] : pos(e.pos);
    throw new YamlError(e.message.split('\n')[0], p.line, p.col);
  }
  const warnings = ydoc.warnings.map((w) => ({ message: w.message.split('\n')[0], ...(w.linePos ? w.linePos[0] : pos(w.pos)) }));
  const meta = { duplicateKeys: [], mergeKeys: [], nonStringKeys: [], explicitClickhouseRoot: null };

  const root = makeNode('clickhouse', 1, 1);
  root.synthetic = true;

  const scalarText = (n) => {
    if (n.value === null || n.value === undefined) return null;
    if (typeof n.source === 'string') return n.source;
    return String(n.value);
  };
  const resolve = (n) => (YAML.isAlias(n) ? n.resolve(ydoc) : n);

  const cloneFor = (el) => {
    const c = makeNode(el.name, el.line, el.col);
    c.parent = el.parent;
    c.yamlSeqClone = true;
    const siblings = el.parent.children;
    siblings.push(c);
    return c;
  };

  const processNode = (yn, el) => {
    yn = resolve(yn);
    if (yn == null) return;
    if (YAML.isScalar(yn)) {
      const t = scalarText(yn);
      if (t === null) return; // YAML null -> empty element
      const p = pos(yn.range);
      el.text = (el.text ?? '') + t;
      el.textLine = p.line;
      el.yamlScalarType = yn.type;
      return;
    }
    if (YAML.isSeq(yn)) {
      yn.items.forEach((item, idx) => {
        processNode(item, idx === 0 ? el : cloneFor(el));
      });
      return;
    }
    if (YAML.isMap(yn)) {
      const seen = new Map();
      for (const pair of yn.items) {
        const keyNode = resolve(pair.key);
        const kp = pos(keyNode && keyNode.range);
        if (keyNode && !YAML.isScalar(keyNode)) {
          meta.nonStringKeys.push({ line: kp.line, col: kp.col });
          continue;
        }
        const key = keyNode == null ? '' : String(keyNode.value ?? '');
        if (key === '<<') meta.mergeKeys.push({ line: kp.line, col: kp.col, path: pathOf(el) });
        const vn = resolve(pair.value);
        if (seen.has(key)) meta.duplicateKeys.push({ key, line: kp.line, col: kp.col, first: seen.get(key), path: pathOf(el) });
        else seen.set(key, kp.line);
        if (key.startsWith('@') && (vn == null || YAML.isScalar(vn))) {
          el.attrs.set(key.slice(1), { value: vn == null ? '' : (scalarText(vn) ?? ''), line: kp.line, col: kp.col });
          continue;
        }
        if (key === '#text' && (vn == null || YAML.isScalar(vn))) {
          if (el.text != null) throw new YamlError("Node has several text nodes ('#text' combined with a scalar value); YAMLParser rejects this", kp.line, kp.col);
          el.text = vn == null ? '' : (scalarText(vn) ?? '');
          el.textLine = kp.line;
          continue;
        }
        const c = makeNode(key, kp.line, kp.col);
        c.parent = el;
        el.children.push(c);
        processNode(vn, c);
      }
      return;
    }
  };

  const contents = ydoc.contents;
  if (YAML.isSeq(contents)) contents.items.forEach((it) => processNode(it, root));
  else processNode(contents, root);

  // A leaf element that ends up with children and text is mixed content; normalise like the XML front-end.
  walk(root, (n) => {
    if (n.children.length && n.text != null) {
      if (n.text.trim()) n.mixedText = { text: n.text.trim(), line: n.textLine, col: 1 };
      n.text = null;
    }
    n.endLine = Math.max(n.line, ...n.children.map((c) => c.endLine || c.line));
  });

  // Detect an explicit top-level `clickhouse:` key (see validate.js for why this matters).
  if (root.children.length === 1 && (root.children[0].name === 'clickhouse' || root.children[0].name === 'yandex')) {
    meta.explicitClickhouseRoot = root.children[0];
  }

  // Collect comments for the formatter (top-level only is enough for round-tripping hints).
  return { root, warnings, meta, ydoc };
}
