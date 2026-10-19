// Text edits behind the one-click quick fixes. They change only the lines involved, so the rest of the
// file keeps its formatting and comments. Each returns the new text, or null when the edit isn't safe.

import { parseXml } from './xml.js';
import { walk, child } from './tree.js';

const indentOf = (l) => /^[ \t]*/.exec(l)[0];

/**
 * Move the element named `name` that starts on `line` under `parent`, a dotted path from the document root
 * ('' = top level). Missing sections on the way are created.
 */
export function moveElement(text, format, line, name, parent) {
  const segs = parent ? parent.split('.') : [];
  if (segs.some((s) => !/^[\w.-]+$/.test(s))) return null;
  return format === 'yaml' ? moveYaml(text, line, name, segs) : moveXml(text, line, name, segs);
}

function moveXml(text, line, name, segs) {
  let doc;
  try {
    doc = parseXml(text);
  } catch {
    return null;
  }
  const root = doc.root;
  let node = null;
  walk(root, (n) => {
    if (!node && n !== root && n.line === line && n.name === name) node = n;
  });
  if (!node || node.start == null) return null;
  let t = root,
    i = 0;
  for (let c; i < segs.length && (c = child(t, segs[i])); i++) t = c;
  for (let x = t; x; x = x.parent) if (x === node) return null;
  if (t.selfClosing || (t === node.parent && i === segs.length)) return null;

  const lineStart = (o) => text.lastIndexOf('\n', o - 1) + 1;
  const lineEnd = (o) => {
    const e = text.indexOf('\n', o);
    return e < 0 ? text.length : e;
  };
  const ls = lineStart(node.start),
    le = lineEnd(node.end);
  const alone = !text.slice(ls, node.start).trim() && !text.slice(node.end, le).trim();
  const nodeIndent = alone ? text.slice(ls, node.start) : '';
  const body = text
    .slice(node.start, node.end)
    .split('\n')
    .map((l, k) => (k && l.startsWith(nodeIndent) ? l.slice(nodeIndent.length) : l));

  const first = root.children.find((c) => c.start != null && !text.slice(lineStart(c.start), c.start).trim());
  const rootIndent =
    root.start != null && !text.slice(lineStart(root.start), root.start).trim()
      ? text.slice(lineStart(root.start), root.start)
      : '';
  const unit = (first && text.slice(lineStart(first.start), first.start).slice(rootIndent.length)) || '    ';
  const tLine = text.slice(lineStart(t.start), t.start);
  const tIndent = tLine.trim() ? indentOf(tLine) : tLine;
  const ind = (k) => tIndent + unit.repeat(k + 1);
  const wrap = segs.slice(i);
  const out = [
    ...wrap.map((s, k) => `${ind(k)}<${s}>`),
    ...body.map((l) => (l ? ind(wrap.length) + l : l)),
    ...wrap.map((s, k) => `${ind(k)}</${s}>`).reverse(),
  ];

  const apply = (s, e) => ('str' in e ? s.slice(0, e.at) + e.str + s.slice(e.at) : s.slice(0, e.from) + s.slice(e.to));
  // Moving outwards (e.g. to the top level): put it next to the section it came from, not at the end.
  let anc = node;
  while (anc.parent && anc.parent !== t) anc = anc.parent;
  if (anc === node && node.parent === t) {
    return alone
      ? text.slice(0, ls) + out.join('\n') + text.slice(le)
      : text.slice(0, node.start) + out.join('\n').trimStart() + text.slice(node.end);
  }
  let ins;
  if (anc.parent === t) {
    const own = !text.slice(lineStart(anc.start), anc.start).trim();
    ins = own
      ? { at: lineStart(anc.start), str: out.join('\n') + '\n' }
      : { at: anc.start, str: out.join('\n').trimStart() + '\n' + tIndent + unit };
  } else {
    const cs = t.closeStart;
    const ownLine = !text.slice(lineStart(cs), cs).trim();
    ins = ownLine
      ? { at: lineStart(cs), str: out.join('\n') + '\n' }
      : { at: cs, str: '\n' + out.join('\n') + '\n' + tIndent };
  }
  const del = alone ? { from: ls, to: le < text.length ? le + 1 : le } : { from: node.start, to: node.end };
  // Apply the later edit first so the earlier offsets stay valid.
  return ins.at >= del.to ? apply(apply(text, ins), del) : apply(apply(text, del), ins);
}

function moveYaml(text, line, name, segs) {
  const lines = text.split('\n');
  const li = line - 1;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^([ ]*)(["']?)${esc}\\2[ ]*:(?=\\s|$)`).exec(lines[li] || '');
  if (!m) return null;
  const blank = (l) => !l.trim() || /^\s*#/.test(l);
  const depth = (l) => indentOf(l).length;
  const extent = (from, ind) => {
    let e = from + 1;
    while (e < lines.length && (blank(lines[e]) || depth(lines[e]) > ind)) e++;
    while (e > from + 1 && blank(lines[e - 1])) e--;
    return e;
  };
  const nIndent = m[1].length;
  const nEnd = extent(li, nIndent);
  const block = lines.slice(li, nEnd).map((l) => (l.trim() ? l.slice(nIndent) : ''));

  // Walk the target path by indentation.
  let from = 0,
    to = lines.length,
    pInd = -1,
    i = 0,
    keyLine = -1;
  const childIndent = (a, b, p) => {
    for (let k = a; k < b; k++) if (!blank(lines[k]) && depth(lines[k]) > p) return depth(lines[k]);
    return null;
  };
  for (; i < segs.length; i++) {
    const ci = childIndent(from, to, pInd);
    if (ci == null) break;
    let found = -1;
    for (let k = from; k < to; k++) {
      if (blank(lines[k]) || depth(lines[k]) !== ci) continue;
      const km = new RegExp(`^[ ]*(["']?)${segs[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1[ ]*:(.*)$`).exec(
        lines[k],
      );
      if (km) {
        if (km[2].replace(/#.*/, '').trim()) return null;
        found = k;
        break;
      }
    }
    if (found < 0) break;
    keyLine = found;
    pInd = ci;
    from = found + 1;
    to = extent(found, ci);
  }
  if (keyLine >= li && keyLine < nEnd) return null;
  if (i === segs.length && keyLine === parentKeyLine(lines, li, nIndent, blank, depth)) return null;
  const unitM = /\n( +)\S/.exec(text);
  const unit = unitM ? ' '.repeat(Math.min(unitM[1].length, 4)) : '  ';
  const base = keyLine < 0 ? '' : ' '.repeat(childIndent(from, to, pInd) ?? pInd + unit.length);
  const wrap = segs.slice(i);
  const ins = [
    ...wrap.map((s, k) => base + unit.repeat(k) + `${s}:`),
    ...block.map((l) => (l ? base + unit.repeat(wrap.length) + l : l)),
  ];
  if (li >= from && li < to) {
    // The node is inside the target (moving outwards): place it beside the entry it came from, or wrap it in place.
    const ci = childIndent(from, to, pInd);
    let anc = li;
    while (anc > from && (blank(lines[anc]) || depth(lines[anc]) !== ci)) anc--;
    if (anc === li) {
      lines.splice(li, nEnd - li, ...ins);
      return lines.join('\n');
    }
    while (anc > from && /^\s*#/.test(lines[anc - 1]) && depth(lines[anc - 1]) === ci) anc--;
    lines.splice(li, nEnd - li);
    lines.splice(anc, 0, ...ins);
    return lines.join('\n');
  }
  const at =
    keyLine < 0 && i === 0
      ? (() => {
          let e = lines.length;
          while (e > 0 && !lines[e - 1].trim()) e--;
          return e;
        })()
      : (() => {
          let e = to;
          while (e > from && blank(lines[e - 1])) e--;
          return Math.max(e, from);
        })();
  if (at >= nEnd) {
    lines.splice(at, 0, ...ins);
    lines.splice(li, nEnd - li);
  } else {
    lines.splice(li, nEnd - li);
    lines.splice(at, 0, ...ins);
  }
  return lines.join('\n');
}

// Line index of the mapping key that contains line li (-1 = top level).
function parentKeyLine(lines, li, ind, blank, depth) {
  for (let k = li - 1; k >= 0; k--) if (!blank(lines[k]) && depth(lines[k]) < ind) return k;
  return -1;
}

// ---------------------------------------------------------------- hard-wrapped XML

// A line that a terminal, email client or ticket tool broke at a fixed width, e.g. "</er" + "rorlog>":
// it ends inside a tag name, or inside a value whose closing tag is on the next line. Continuation lines
// start in column 0. A break inside a value is only trusted on a line exactly as long as the longest line
// (the wrap width), which keeps intentionally multi-line text such as SQL out.
const OPEN_NAME_TAIL = /<\/?[\w:.-]*$/;
const OPEN_TEXT_TAIL = /<([\w:.-]+)(?:\s[^<>]*)?>[^<>]*$/;

function continues(acc, next, width) {
  if (next == null || !next.length || /^\s/.test(next) || next.startsWith('<')) return false;
  if (OPEN_NAME_TAIL.test(acc)) return /^[\w:.-]*[\s/>]/.test(next) || /^[\w:.-]+$/.test(next);
  const m = OPEN_TEXT_TAIL.exec(acc);
  if (!m || width < 40 || acc.length % width !== 0) return false;
  // The value goes on and is closed by the same element (or the closing tag is itself split again).
  const c = /^[^<>]*(<\/?[\w:.-]*)/.exec(next);
  if (!c) return /^[^<>]+$/.test(next);
  return c[1] === '<' || c[1] === '</' || (`</${m[1]}`.startsWith(c[1]) && c[1].startsWith('</'));
}

// Lines with trailing whitespace dropped and the paste's common indentation removed, so a block copied
// with extra indentation (or padded by a terminal) still shows continuation lines in column 0.
function normalised(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const indent = Math.min(...lines.filter((l) => l).map((l) => /^[ \t]*/.exec(l)[0].length));
  return {
    lines: Number.isFinite(indent) && indent ? lines.map((l) => l.slice(indent)) : lines,
    indent: Number.isFinite(indent) ? indent : 0,
  };
}

/** Lines (1-based) of hard-wrapped XML whose text continues on the following line. Comments and CDATA are skipped. */
export function findWrappedLines(text) {
  const { lines } = normalised(text);
  const width = Math.max(...lines.map((l) => l.length));
  const out = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const startsInComment = inComment;
    for (let k = 0; ;) {
      if (inComment) {
        const e = l.indexOf('-->', k);
        if (e < 0) break;
        inComment = false;
        k = e + 3;
      } else {
        const s = l.indexOf('<!--', k);
        if (s < 0) break;
        inComment = true;
        k = s + 4;
      }
    }
    if (startsInComment || inComment || l.includes('<![CDATA[')) continue;
    let acc = l,
      j = i;
    while (continues(acc, lines[j + 1], width)) {
      out.push(j + 1);
      acc += lines[j + 1];
      j++;
    }
    i = j;
  }
  return out;
}

/** Join every hard-wrapped line with its continuation. */
export function unwrapLines(text) {
  const wraps = new Set(findWrappedLines(text));
  if (!wraps.size) return text;
  const { indent } = normalised(text);
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (out.length && wraps.has(i))
      out[out.length - 1] =
        out[out.length - 1].replace(/\s+$/, '') +
        lines[i].replace(/\s+$/, '').slice(indent) +
        (lines[i].endsWith('\r') ? '\r' : '');
    else out.push(lines[i]);
  }
  return out.join('\n');
}
