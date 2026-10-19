// Pretty-printing and XML <-> YAML conversion of the config tree.
// The YAML output follows the mapping ClickHouse's YAMLParser uses: repeated elements become sequences,
// attributes become "@name" keys and text next to attributes becomes "#text".

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Serialise a parsed document back to XML, re-indented, keeping comments and the prolog. */
export function toXml(doc, { indent = 4 } = {}) {
  const pad = (d) => ' '.repeat(d * indent);
  const out = [];
  const decl = (doc.prolog || []).find((p) => p.type === 'pi' && /^xml\b/.test(p.body));
  out.push(decl ? `<?${decl.body.trim()}?>` : '<?xml version="1.0"?>');
  for (const c of doc.comments || []) if (c.beforeRoot) out.push(comment(c.text, 0));
  const root = doc.root;
  emit(root, 0);
  for (const c of doc.comments || []) if (!c.beforeRoot) out.push(comment(c.text, 0));
  return out.join('\n') + '\n';

  function comment(text, d) {
    const lines = text.split('\n');
    if (lines.length === 1) return `${pad(d)}<!--${text}-->`;
    // Re-indent multi-line comments relative to their minimal indentation.
    const body = lines.slice(1);
    const min = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), Infinity);
    return (
      [
        `${pad(d)}<!--${lines[0]}`,
        ...body.map((l) => (l.trim() ? pad(d) + l.slice(Number.isFinite(min) ? min : 0) : '')),
      ].join('\n') + '-->'
    );
  }

  function emit(n, d) {
    const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escAttr(v.value)}"`).join('');
    const comments = n.comments || [];
    if (!n.children.length) {
      const t = n.text == null ? '' : n.text.trim();
      if (!t && !comments.length) {
        out.push(`${pad(d)}<${n.name}${attrs}/>`);
        return;
      }
      if (!comments.length) {
        const body = n.hasCdata ? `<![CDATA[${t}]]>` : escText(t);
        out.push(`${pad(d)}<${n.name}${attrs}>${body}</${n.name}>`);
        return;
      }
      out.push(`${pad(d)}<${n.name}${attrs}>`);
      for (const c of comments) out.push(comment(c.text, d + 1));
      if (t) out.push(pad(d + 1) + (n.hasCdata ? `<![CDATA[${t}]]>` : escText(t)));
      out.push(`${pad(d)}</${n.name}>`);
      return;
    }
    out.push(`${pad(d)}<${n.name}${attrs}>`);
    n.children.forEach((c, i) => {
      for (const cm of comments) if (cm.index === i) out.push(comment(cm.text, d + 1));
      emit(c, d + 1);
    });
    for (const cm of comments) if (cm.index >= n.children.length) out.push(comment(cm.text, d + 1));
    out.push(`${pad(d)}</${n.name}>`);
  }
}

const PLAIN_SCALAR = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^\n]*$/;
function yScalar(s) {
  if (s === '') return '""';
  if (PLAIN_SCALAR.test(s) && !/:\s|\s#|:$|\s$/.test(s) && !/^(-|\?|:)(\s|$)/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}
function yKey(k) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : yScalar(k).startsWith('"') ? yScalar(k) : `"${k}"`;
}

/** Convert a config tree to YAML following the rules of ClickHouse's YAMLParser in reverse (repeated elements become sequences, attributes "@name" keys). */
export function toYaml(root, { indent = 2, comments = true } = {}) {
  const pad = (d) => ' '.repeat(d * indent);
  const lines = [];
  const commentLines = (cms, d) => {
    if (!comments) return;
    for (const c of cms)
      for (const l of c.text.trim().split('\n')) lines.push(`${pad(d)}#${l.trim() ? ' ' + l.trim() : ''}`);
  };
  emitBody(root, 0);
  return lines.join('\n') + '\n';

  // Emit the attributes, text and children of `n` as mapping entries at depth d.
  function emitBody(n, d) {
    for (const [k, v] of n.attrs) lines.push(`${pad(d)}"@${k}": ${yScalar(v.value)}`);
    if (n.attrs.size && n.text != null && n.text.trim() !== '')
      lines.push(`${pad(d)}"#text": ${yScalar(n.text.trim())}`);
    const groups = new Map();
    n.children.forEach((c, i) => {
      if (!groups.has(c.name)) groups.set(c.name, { items: [], firstIndex: i });
      groups.get(c.name).items.push(c);
    });
    const cms = n.comments || [];
    for (const [name, g] of groups) {
      commentLines(
        cms.filter((c) => g.items.some((it) => n.children.indexOf(it) === c.index)),
        d,
      );
      if (g.items.length === 1) emitEntry(name, g.items[0], d);
      else {
        lines.push(`${pad(d)}${yKey(name)}:`);
        for (const it of g.items) emitSeqItem(it, d + 1);
      }
    }
    commentLines(
      cms.filter((c) => c.index >= n.children.length),
      d,
    );
  }

  function isScalarLeaf(n) {
    return !n.children.length && !n.attrs.size;
  }

  function emitEntry(name, n, d) {
    if (isScalarLeaf(n)) {
      const t = n.text == null ? '' : n.text.trim();
      lines.push(`${pad(d)}${yKey(name)}:${t === '' ? '' : ' ' + yScalar(t)}`);
      return;
    }
    lines.push(`${pad(d)}${yKey(name)}:`);
    emitBody(n, d + 1);
  }

  function emitSeqItem(n, d) {
    if (isScalarLeaf(n)) {
      const t = n.text == null ? '' : n.text.trim();
      lines.push(`${pad(d)}- ${yScalar(t)}`);
      return;
    }
    const start = lines.length;
    emitBody(n, d + 1);
    if (lines.length === start) {
      lines.push(`${pad(d)}- {}`);
      return;
    }
    // Turn the first emitted line into the "- " item marker.
    const first = start < lines.length ? lines.findIndex((l, i) => i >= start && !l.trimStart().startsWith('#')) : -1;
    if (first >= 0) lines[first] = `${pad(d)}- ${lines[first].slice(pad(d + 1).length)}`;
  }
}

/** Canonical YAML formatting that keeps comments (uses the yaml library's document model). */
export function formatYamlDoc(ydoc) {
  return ydoc.toString({ indent: 2, lineWidth: 0, minContentWidth: 0 });
}
