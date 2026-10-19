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
  try { doc = parseXml(text); } catch { return null; }
  const root = doc.root;
  let node = null;
  walk(root, (n) => { if (!node && n !== root && n.line === line && n.name === name) node = n; });
  if (!node || node.start == null) return null;
  let t = root, i = 0;
  for (let c; i < segs.length && (c = child(t, segs[i])); i++) t = c;
  for (let x = t; x; x = x.parent) if (x === node) return null;
  if (t.selfClosing || (t === node.parent && i === segs.length)) return null;

  const lineStart = (o) => text.lastIndexOf('\n', o - 1) + 1;
  const lineEnd = (o) => { const e = text.indexOf('\n', o); return e < 0 ? text.length : e; };
  const ls = lineStart(node.start), le = lineEnd(node.end);
  const alone = !text.slice(ls, node.start).trim() && !text.slice(node.end, le).trim();
  const nodeIndent = alone ? text.slice(ls, node.start) : '';
  const body = text.slice(node.start, node.end).split('\n').map((l, k) => (k && l.startsWith(nodeIndent) ? l.slice(nodeIndent.length) : l));

  const first = root.children.find((c) => c.start != null && !text.slice(lineStart(c.start), c.start).trim());
  const rootIndent = root.start != null && !text.slice(lineStart(root.start), root.start).trim() ? text.slice(lineStart(root.start), root.start) : '';
  const unit = (first && text.slice(lineStart(first.start), first.start).slice(rootIndent.length)) || '    ';
  const tLine = text.slice(lineStart(t.start), t.start);
  const tIndent = tLine.trim() ? indentOf(tLine) : tLine;
  const ind = (k) => tIndent + unit.repeat(k + 1);
  const wrap = segs.slice(i);
  const out = [...wrap.map((s, k) => `${ind(k)}<${s}>`), ...body.map((l) => (l ? ind(wrap.length) + l : l)), ...wrap.map((s, k) => `${ind(k)}</${s}>`).reverse()];

  const cs = t.closeStart;
  const ownLine = !text.slice(lineStart(cs), cs).trim();
  const ins = ownLine ? { at: lineStart(cs), str: out.join('\n') + '\n' } : { at: cs, str: '\n' + out.join('\n') + '\n' + tIndent };
  const del = alone ? { from: ls, to: le < text.length ? le + 1 : le } : { from: node.start, to: node.end };
  const apply = (s, e) => ('str' in e ? s.slice(0, e.at) + e.str + s.slice(e.at) : s.slice(0, e.from) + s.slice(e.to));
  return ins.at >= del.to ? apply(apply(text, ins), del) : apply(apply(text, del), { ...ins, at: ins.at - (del.to - del.from) });
}

function moveYaml(text, line, name, segs) {
  const lines = text.split('\n');
  const li = line - 1;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^([ ]*)(["']?)${esc}\\2[ ]*:(?=\\s|$)`).exec(lines[li] || '');
  if (!m) return null;
  const blank = (l) => !l.trim() || /^\s*#/.test(l);
  const depth = (l) => indentOf(l).length;
  const extent = (from, ind) => { let e = from + 1; while (e < lines.length && (blank(lines[e]) || depth(lines[e]) > ind)) e++; while (e > from + 1 && blank(lines[e - 1])) e--; return e; };
  const nIndent = m[1].length;
  const nEnd = extent(li, nIndent);
  const block = lines.slice(li, nEnd).map((l) => (l.trim() ? l.slice(nIndent) : ''));

  // Walk the target path by indentation.
  let from = 0, to = lines.length, pInd = -1, i = 0, keyLine = -1;
  const childIndent = (a, b, p) => { for (let k = a; k < b; k++) if (!blank(lines[k]) && depth(lines[k]) > p) return depth(lines[k]); return null; };
  for (; i < segs.length; i++) {
    const ci = childIndent(from, to, pInd);
    if (ci == null) break;
    let found = -1;
    for (let k = from; k < to; k++) {
      if (blank(lines[k]) || depth(lines[k]) !== ci) continue;
      const km = new RegExp(`^[ ]*(["']?)${segs[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1[ ]*:(.*)$`).exec(lines[k]);
      if (km) { if (km[2].replace(/#.*/, '').trim()) return null; found = k; break; }
    }
    if (found < 0) break;
    keyLine = found; pInd = ci; from = found + 1; to = extent(found, ci);
  }
  if (keyLine >= li && keyLine < nEnd) return null;
  if (i === segs.length && keyLine === parentKeyLine(lines, li, nIndent, blank, depth)) return null;
  const unitM = /\n( +)\S/.exec(text);
  const unit = unitM ? ' '.repeat(Math.min(unitM[1].length, 4)) : '  ';
  const base = keyLine < 0 ? '' : ' '.repeat((childIndent(from, to, pInd) ?? pInd + unit.length));
  const at = keyLine < 0 && i === 0 ? (() => { let e = lines.length; while (e > 0 && !lines[e - 1].trim()) e--; return e; })() : (() => { let e = to; while (e > from && blank(lines[e - 1])) e--; return Math.max(e, from); })();
  const wrap = segs.slice(i);
  const ins = [...wrap.map((s, k) => base + unit.repeat(k) + `${s}:`), ...block.map((l) => (l ? base + unit.repeat(wrap.length) + l : l))];
  if (at >= nEnd) { lines.splice(at, 0, ...ins); lines.splice(li, nEnd - li); } else { lines.splice(li, nEnd - li); lines.splice(at, 0, ...ins); }
  return lines.join('\n');
}

// Line index of the mapping key that contains line li (-1 = top level).
function parentKeyLine(lines, li, ind, blank, depth) {
  for (let k = li - 1; k >= 0; k--) if (!blank(lines[k]) && depth(lines[k]) < ind) return k;
  return -1;
}
