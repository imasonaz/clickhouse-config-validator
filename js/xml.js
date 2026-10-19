// Minimal, position-aware XML parser for ClickHouse configuration files.
// Produces the shared config tree (see tree.js) and reports well-formedness errors with line/column.

import { makeNode } from './tree.js';

const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export class XmlError extends Error {
  constructor(message, line, col) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

/**
 * Parse XML into the shared config tree, keeping line/column and character offsets for every element.
 * Throws XmlError with line and col on malformed input.
 */
export function parseXml(src) {
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;
  const warnings = [];

  const err = (msg, l = line, c = col) => {
    throw new XmlError(msg, l, c);
  };
  const advance = (k = 1) => {
    for (let j = 0; j < k && i < n; j++, i++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
    }
  };
  const startsWith = (s) => src.startsWith(s, i);
  const skipWs = () => {
    while (i < n && /\s/.test(src[i])) advance();
  };

  const decode = (raw, l, c) =>
    raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);?/g, (m, ent) => {
      if (!m.endsWith(';')) err(`Unescaped '&' in text or attribute. Use &amp;`, l, c);
      if (ent[0] === '#') {
        const cp = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        try {
          return String.fromCodePoint(cp);
        } catch {
          err(`Invalid character reference ${m}`, l, c);
        }
      }
      if (!(ent in ENTITIES)) err(`Unknown entity ${m}`, l, c);
      return ENTITIES[ent];
    });

  const readName = () => {
    const l = line,
      c = col;
    if (i >= n || !NAME_START.test(src[i])) err(`Invalid name start character '${src[i] ?? 'EOF'}'`);
    const s = i;
    while (i < n && NAME_CHAR.test(src[i])) advance();
    return { name: src.slice(s, i), line: l, col: c };
  };

  const skipUntil = (end, what) => {
    const l = line,
      c = col;
    const idx = src.indexOf(end, i);
    if (idx < 0) err(`Unterminated ${what}`, l, c);
    const body = src.slice(i, idx);
    advance(idx + end.length - i);
    return body;
  };

  const doc = { root: null, comments: [], warnings, prolog: [] };
  const stack = [];

  const addText = (node, text, l, c) => {
    if (!node) {
      if (text.trim()) err('Text content outside the root element', l, c);
      return;
    }
    node._textParts.push({ text, line: l, col: c });
  };

  while (i < n) {
    if (startsWith('<?')) {
      const l = line,
        c = col;
      advance(2);
      const body = skipUntil('?>', 'processing instruction');
      if (
        /^xml\b/.test(body) &&
        (doc.root || stack.length || doc.comments.length || src.slice(0, i - body.length - 4).trim())
      )
        err('XML declaration must be at the very start of the document', l, c);
      doc.prolog.push({ type: 'pi', body, line: l });
      continue;
    }
    if (startsWith('<!--')) {
      const l = line,
        c = col;
      advance(4);
      const body = skipUntil('-->', 'comment');
      if (body.includes('--')) warnings.push({ message: "'--' is not allowed inside XML comments", line: l, col: c });
      const parent = stack[stack.length - 1];
      const cm = { text: body, line: l, col: c };
      if (parent) parent.comments.push({ ...cm, index: parent.children.length });
      else doc.comments.push({ ...cm, beforeRoot: !doc.root });
      continue;
    }
    if (startsWith('<![CDATA[')) {
      const l = line,
        c = col;
      advance(9);
      const body = skipUntil(']]>', 'CDATA section');
      const parent = stack[stack.length - 1];
      if (!parent) err('CDATA outside the root element', l, c);
      parent._textParts.push({ text: body, line: l, col: c, cdata: true });
      continue;
    }
    if (startsWith('<!DOCTYPE')) {
      const l = line;
      advance(9);
      let depth = 0;
      while (i < n && !(src[i] === '>' && depth === 0)) {
        if (src[i] === '[') depth++;
        if (src[i] === ']') depth--;
        advance();
      }
      advance();
      doc.prolog.push({ type: 'doctype', line: l });
      continue;
    }
    if (startsWith('</')) {
      const l = line,
        c = col,
        closeStart = i;
      advance(2);
      const { name } = readName();
      skipWs();
      if (src[i] !== '>') err(`Expected '>' to close </${name}>`);
      advance();
      const open = stack.pop();
      if (!open) err(`Closing tag </${name}> has no matching opening tag`, l, c);
      if (open.name !== name)
        err(`Mismatched closing tag: expected </${open.name}> (opened at line ${open.line}), found </${name}>`, l, c);
      open.endLine = l;
      open.closeStart = closeStart;
      open.end = i;
      finishNode(open);
      continue;
    }
    if (src[i] === '<') {
      const l = line,
        c = col,
        start = i;
      advance();
      const { name } = readName();
      if (!stack.length && doc.root) err(`Only one root element is allowed; found second root <${name}>`, l, c);
      const node = makeNode(name, l, c);
      node.start = start;
      node._textParts = [];
      for (;;) {
        const hadWs = /\s/.test(src[i] ?? '');
        skipWs();
        if (i >= n) err(`Unterminated start tag <${name}>`, l, c);
        if (startsWith('/>')) {
          advance(2);
          node.selfClosing = true;
          break;
        }
        if (src[i] === '>') {
          advance();
          break;
        }
        if (!hadWs) err(`Expected whitespace before attribute in <${name}>`);
        const an = readName();
        skipWs();
        if (src[i] !== '=') err(`Attribute '${an.name}' in <${name}> has no value`, an.line, an.col);
        advance();
        skipWs();
        const q = src[i];
        if (q !== '"' && q !== "'") err(`Attribute '${an.name}' value must be quoted`);
        advance();
        const vl = line,
          vc = col;
        const end = src.indexOf(q, i);
        if (end < 0) err(`Unterminated attribute value for '${an.name}'`, vl, vc);
        const raw = src.slice(i, end);
        if (raw.includes('<')) err(`'<' is not allowed in attribute values (attribute '${an.name}')`, vl, vc);
        advance(end - i + 1);
        if (node.attrs.has(an.name)) err(`Duplicate attribute '${an.name}' in <${name}>`, an.line, an.col);
        node.attrs.set(an.name, { value: decode(raw, vl, vc), line: an.line, col: an.col });
      }
      const parent = stack[stack.length - 1];
      if (parent) {
        node.parent = parent;
        parent.children.push(node);
      } else doc.root = node;
      node.openEnd = i;
      if (node.selfClosing) {
        node.endLine = l;
        node.end = i;
        finishNode(node);
      } else stack.push(node);
      continue;
    }
    // text
    const l = line,
      c = col;
    let end = src.indexOf('<', i);
    if (end < 0) end = n;
    const raw = src.slice(i, end);
    if (raw.includes(']]>')) err("']]>' is not allowed in text content", l, c);
    advance(end - i);
    addText(stack[stack.length - 1], decode(raw, l, c), l, c);
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    err(`Element <${open.name}> opened at line ${open.line} is never closed`, open.line, open.col);
  }
  if (!doc.root) err('Document has no root element', 1, 1);
  return doc;

  function finishNode(node) {
    const parts = node._textParts;
    delete node._textParts;
    const text = parts.map((p) => p.text).join('');
    if (node.children.length) {
      if (text.trim()) {
        const p = parts.find((x) => x.text.trim());
        node.mixedText = { text: text.trim(), line: p.line, col: p.col };
      }
      node.text = null;
    } else {
      node.text = text;
      const lead = (text.match(/^\s*/) || [''])[0];
      node.textLine = (parts.length ? parts[0].line : node.line) + (lead.match(/\n/g) || []).length;
      node.hasCdata = parts.some((p) => p.cdata);
    }
  }
}
