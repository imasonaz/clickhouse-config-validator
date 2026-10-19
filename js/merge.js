// Simulates ClickHouse's ConfigProcessor: merges config.d / users.d fragments into the main file, then
// applies incl / from_env / from_zk substitutions. Mirrors src/Common/Config/ConfigProcessor.cpp
// (getConfigMergeFiles, merge, mergeRecursive, doIncludesRecursive).

import { makeNode, walk, child, getPath } from './tree.js';
import { parseXml } from './xml.js';

const IDENT_SKIP = new Set(['replace', 'remove', 'yaml', 'incl', 'from_zk', 'from_env']);
const SUBST_ATTRS = ['incl', 'from_zk', 'from_env'];
const CONFIG_EXT = /\.(xml|conf|yaml|yml)$/i;

/** Tag every node of a parsed document with the file it came from. */
export function tagFile(root, file) {
  walk(root, (n) => { n.file = file; });
}

export function cloneNode(n, parent = null) {
  const c = { ...n, attrs: new Map([...n.attrs].map(([k, v]) => [k, { ...v }])), comments: [...(n.comments || [])], parent, children: [] };
  c.children = n.children.map((ch) => cloneNode(ch, c));
  return c;
}

/** ElementIdentifier: [name, k1, v1, ...] with attributes sorted as (name, value) pairs. */
const identifier = (n) => [n.name, ...[...n.attrs].filter(([k]) => !IDENT_SKIP.has(k)).map(([k, v]) => [k, v.value])
  .sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1])).flat()];
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** std::vector<std::string> operator< as a three-way compare. */
function cmpId(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++) { const c = cmpStr(a[i], b[i]); if (c) return c; }
  return a.length - b.length;
}

/**
 * The std::multimap<ElementIdentifier, Node *> that mergeRecursive builds, reproduced as libc++'s red-black
 * tree. Which of several identical siblings a fragment element merges into depends on the tree's shape:
 * find() returns the first equal node met descending from the root, not the first in document order.
 */
class IdMultimap {
  constructor() { this.end = { left: null }; }
  insert(key, value) {
    const z = { key, value, left: null, right: null, parent: this.end, black: false };
    let p = this.end, nd = this.end.left, left = true;
    while (nd) { p = nd; left = cmpId(key, nd.key) < 0; nd = left ? nd.left : nd.right; }
    z.parent = p;
    if (left) p.left = z; else p.right = z;
    this.balanceAfterInsert(this.end.left, z);
  }
  find(key) {
    let nd = this.end.left;
    while (nd) { const c = cmpId(key, nd.key); if (c < 0) nd = nd.left; else if (c > 0) nd = nd.right; else return nd; }
    return null;
  }
  static isLeft(x) { return x === x.parent.left; }
  static rotL(x) {
    const y = x.right; x.right = y.left; if (x.right) x.right.parent = x;
    y.parent = x.parent; if (IdMultimap.isLeft(x)) x.parent.left = y; else x.parent.right = y;
    y.left = x; x.parent = y;
  }
  static rotR(x) {
    const y = x.left; x.left = y.right; if (x.left) x.left.parent = x;
    y.parent = x.parent; if (IdMultimap.isLeft(x)) x.parent.left = y; else x.parent.right = y;
    y.right = x; x.parent = y;
  }
  balanceAfterInsert(root, x) {
    const isLeft = IdMultimap.isLeft;
    x.black = x === root;
    while (x !== root && !x.parent.black) {
      if (isLeft(x.parent)) {
        const y = x.parent.parent.right;
        if (y && !y.black) {
          x = x.parent; x.black = true; x = x.parent; x.black = x === root; y.black = true;
        } else {
          if (!isLeft(x)) { x = x.parent; IdMultimap.rotL(x); }
          x = x.parent; x.black = true; x = x.parent; x.black = false; IdMultimap.rotR(x); break;
        }
      } else {
        const y = x.parent.parent.left;
        if (y && !y.black) {
          x = x.parent; x.black = true; x = x.parent; x.black = x === root; y.black = true;
        } else {
          if (isLeft(x)) { x = x.parent; IdMultimap.rotR(x); }
          x = x.parent; x.black = true; x = x.parent; x.black = false; IdMultimap.rotL(x); break;
        }
      }
    }
  }
  /** libc++ __tree_remove. */
  erase(z) {
    const isLeft = IdMultimap.isLeft, blk = (n) => !n || n.black;
    let root = this.end.left;
    let y = z;
    if (z.left && z.right) { y = z.right; while (y.left) y = y.left; }
    let x = y.left || y.right, w = null;
    if (x) x.parent = y.parent;
    if (isLeft(y)) { y.parent.left = x; if (y !== root) w = y.parent.right; else root = x; } else { y.parent.right = x; w = y.parent.left; }
    const removedBlack = y.black;
    if (y !== z) {
      y.parent = z.parent;
      if (isLeft(z)) y.parent.left = y; else y.parent.right = y;
      y.left = z.left; y.left.parent = y;
      y.right = z.right; if (y.right) y.right.parent = y;
      y.black = z.black;
      if (root === z) root = y;
    }
    if (!removedBlack || !root) return;
    if (x) { x.black = true; return; }
    for (;;) {
      if (!isLeft(w)) {
        if (!w.black) { w.black = true; w.parent.black = false; IdMultimap.rotL(w.parent); if (root === w.left) root = w; w = w.left.right; }
        if (blk(w.left) && blk(w.right)) {
          w.black = false; x = w.parent;
          if (x === root || !x.black) { x.black = true; break; }
          w = isLeft(x) ? x.parent.right : x.parent.left;
        } else {
          if (blk(w.right)) { w.left.black = true; w.black = false; IdMultimap.rotR(w); w = w.parent; }
          w.black = w.parent.black; w.parent.black = true; w.right.black = true; IdMultimap.rotL(w.parent); break;
        }
      } else {
        if (!w.black) { w.black = true; w.parent.black = false; IdMultimap.rotR(w.parent); if (root === w.right) root = w; w = w.right.left; }
        if (blk(w.left) && blk(w.right)) {
          w.black = false; x = w.parent;
          if (!x.black || x === root) { x.black = true; break; }
          w = isLeft(x) ? x.parent.right : x.parent.left;
        } else {
          if (blk(w.left)) { w.right.black = true; w.black = false; IdMultimap.rotL(w); w = w.parent; }
          w.black = w.parent.black; w.parent.black = true; w.left.black = true; IdMultimap.rotR(w.parent); break;
        }
      }
    }
  }
}

/** Directory and basename helpers for forward-slash paths. */
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p) => basename(p).replace(/\.[^.]+$/, '');

/**
 * Decide the role of each file relative to the main file, the way getConfigMergeFiles does:
 * fragments live in "<main stem>.d/" or "conf.d/" next to the main file; the file named by
 * <include_from> supplies incl substitutions. Loose files without a directory are treated as fragments, except
 * well-known main files (config.xml, users.xml, keeper_config.xml), which ClickHouse loads separately.
 */
export function planFiles(files, mainPath, includeFrom) {
  const mainDir = dirname(mainPath);
  const dirs = new Set([[mainDir, `${stem(mainPath)}.d`].filter(Boolean).join('/'), [mainDir, 'conf.d'].filter(Boolean).join('/')]);
  const incBase = includeFrom ? basename(includeFrom) : null;
  const plan = [];
  for (const f of files) {
    if (f.path === mainPath) { plan.push({ ...f, role: 'main' }); continue; }
    if (incBase && (f.path === includeFrom || basename(f.path) === incBase)) { plan.push({ ...f, role: 'include' }); continue; }
    const d = dirname(f.path);
    const name = basename(f.path);
    if (d === mainDir && /^(config|keeper_config|users)\.(xml|ya?ml)$/i.test(name)) { plan.push({ ...f, role: 'separate', reason: 'loaded as its own config file, with its own .d directory' }); continue; }
    if (!CONFIG_EXT.test(name)) { plan.push({ ...f, role: 'ignored', reason: 'extension is not .xml, .conf, .yaml or .yml' }); continue; }
    if (name.startsWith('.')) { plan.push({ ...f, role: 'ignored', reason: 'name starts with "." (treated as a temporary file)' }); continue; }
    if (d && !dirs.has(d)) { plan.push({ ...f, role: 'ignored', reason: `not in ${[...dirs].join(' or ')}` }); continue; }
    plan.push({ ...f, role: 'fragment' });
  }
  // Fragments merge in lexicographic order of their full paths (std::string ordering, i.e. by code unit).
  const sortKey = (f) => (dirname(f.path) ? f.path : [mainDir, `${stem(mainPath)}.d`, f.path].filter(Boolean).join('/'));
  plan.sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  return plan;
}

/**
 * Merge parsed fragments into the main document.
 * docs: [{ path, doc }] with the main document first. Returns { root, events, findings }.
 */
export function mergeDocs(docs) {
  const events = [];   // provenance: what each fragment changed
  const findings = [];
  const [main, ...rest] = docs;
  const root = cloneNode(main.doc.root);
  root.synthetic = main.doc.root.synthetic;
  const rootOk = (n) => n === 'clickhouse' || n === 'yandex';

  for (const { path, doc } of rest) {
    const withRoot = doc.root;
    if (root.name !== withRoot.name && !(rootOk(root.name) && rootOk(withRoot.name))) {
      if (!rootOk(root.name)) {
        findings.push({ sev: 'warning', code: 'merge-skipped', file: path, line: withRoot.line, msg: `Not merged: the main file's root <${root.name}> is not <clickhouse>, so ClickHouse skips merging.` });
        continue;
      }
      findings.push({ sev: 'error', code: 'merge-root', file: path, line: withRoot.line, msg: `Root element <${withRoot.name}> doesn't match the main config's <${root.name}>; ClickHouse fails with "Root element doesn't have the corresponding root element as the config file".` });
      continue;
    }
    mergeRecursive(root, withRoot, path);
  }
  return { root, events, findings };

  function mergeRecursive(cfg, withNode, path) {
    // Remove non-whitespace text from the target (it is replaced by the fragment's text, if any).
    const hadText = cfg.text != null && cfg.text.trim() !== '';
    const available = new IdMultimap();
    for (const c of cfg.children) available.insert(identifier(c), c);
    for (const w of withNode.children) {
      const remove = w.attrs.has('remove');
      const replace = w.attrs.has('replace');
      if (remove && replace) {
        findings.push({ sev: 'error', code: 'replace-remove', file: path, line: w.line, msg: `Both remove and replace attributes set for element <${w.name}>; ClickHouse throws while merging.` });
        continue;
      }
      const match = available.find(identifier(w));
      if (match) {
        available.erase(match);
        const target = match.value;
        if (remove) {
          cfg.children.splice(cfg.children.indexOf(target), 1);
          events.push({ type: 'remove', file: path, line: w.line, target: describe(target) });
        } else if (replace) {
          const nn = cloneNode(w, cfg);
          nn.attrs.delete('replace');
          cfg.children.splice(cfg.children.indexOf(target), 1, nn);
          events.push({ type: 'replace', file: path, line: w.line, target: describe(target) });
        } else {
          const sourceHasValue = w.children.length || (w.text != null && w.text !== '');
          if (sourceHasValue) for (const a of SUBST_ATTRS) target.attrs.delete(a);
          for (const [k, v] of w.attrs) target.attrs.set(k, { ...v, file: path });
          if (!w.children.length && !target.children.length) {
            const before = target.text;
            if (before != null && before.trim() !== '' && (w.text ?? '') !== before) {
              events.push({ type: 'override', file: path, line: w.textLine || w.line, target: describe(target), from: before.trim(), to: (w.text ?? '').trim() });
              target.overridden = [...(target.overridden || []), { file: target.textFile || target.file, line: target.textLine, value: before.trim() }];
            }
            target.text = w.text ?? (before != null && before.trim() !== '' ? '' : before);
            target.textLine = w.textLine || w.line;
            target.textFile = path;
          } else {
            if (target.text != null && target.text.trim() !== '' && w.children.length) target.text = null;
            mergeRecursive(target, w, path);
          }
        }
      } else if (remove) {
        events.push({ type: 'remove-missing', file: path, line: w.line, target: w.name });
      } else {
        const nn = cloneNode(w, cfg);
        deleteAttributesRecursive(nn);
        cfg.children.push(nn);
        if (cfg.text != null && cfg.text.trim() === '') cfg.text = null;
        if (cfg.text != null && cfg.text.trim() !== '' && hadText) { cfg.mixedText = { text: cfg.text.trim(), line: cfg.textLine }; cfg.text = null; }
      }
    }
  }
}

function deleteAttributesRecursive(n) {
  n.children = n.children.filter((c) => !c.attrs.has('remove'));
  for (const c of n.children) {
    c.attrs.delete('replace');
    deleteAttributesRecursive(c);
  }
}

function describe(n) {
  const parts = [];
  for (let x = n; x && x.parent; x = x.parent) parts.unshift(x.name);
  return parts.join('.');
}

/**
 * Apply incl / from_env / from_zk substitutions (doIncludesRecursive).
 * env: Map name -> value. zk: Map path -> value. includeRoot: root node of the include_from file or null.
 * Returns findings about unresolved or malformed substitutions.
 */
export function applySubstitutions(root, { env = new Map(), zk = new Map(), includeRoot = null, includePath = '' } = {}) {
  const findings = [];
  const fragment = (xml, kind, key, c) => {
    try { return parseXml(`<${kind}>${xml}</${kind}>`).root; }
    catch (e) {
      findings.push({ sev: 'error', code: 'subst-xml', file: c.file, line: c.line, msg: `Value of ${kind === 'from_zk' ? 'ZooKeeper node' : 'environment variable'} ${key} is not a well-formed XML fragment (${e.message}); ClickHouse fails to parse it.` });
      return null;
    }
  };
  const lookup = (kind, key, c) => {
    if (kind === 'incl') return includeRoot ? getPath(includeRoot, key) : null;
    if (kind === 'from_env') {
      if (!env.has(key)) return null;
      // <include from_env> splices an XML fragment; a direct from_env is always literal text.
      return c.name === 'include' ? fragment(env.get(key), kind, key, c) : { name: kind, attrs: new Map(), children: [], text: env.get(key) };
    }
    if (!zk.has(key)) return null;
    return fragment(zk.get(key), kind, key, c);   // from_zk values are parsed as XML
  };
  const visit = (n) => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      const substs = SUBST_ATTRS.filter((a) => c.attrs.has(a));
      if (substs.length !== 1) { visit(c); continue; }
      const kind = substs[0];
      const key = c.attrs.get(kind).value;
      const src = lookup(kind, key, c);
      const tag = { kind, key, file: kind === 'incl' ? includePath : null };
      if (!src) {
        if (c.attrs.has('optional') || c.name === 'include') { n.children.splice(i, 1); i--; }
        if (!c.attrs.has('optional') && !(kind === 'incl' && !includeRoot)) {
          const what = kind === 'from_env' ? `environment variable ${key}` : kind === 'from_zk' ? `ZooKeeper node ${key}` : `'${key}' in ${includePath}`;
          const kept = c.name !== 'include' && (c.children.length || (c.text && c.text.trim()));
          findings.push({ sev: kind === 'incl' ? 'warning' : 'info', code: 'subst-missing', file: c.file, line: c.line,
            msg: `No value provided for ${what}; ClickHouse logs a warning and ${c.name === 'include' ? 'drops the <include>' : kept ? `keeps <${c.name}>'s default` : `leaves <${c.name}> empty`}.${kind === 'incl' ? '' : ' Add it under Substitutions to validate the real value.'}` });
        }
        if (!(c.attrs.has('optional') || c.name === 'include')) visit(c);
        continue;
      }
      if (c.name === 'include') {
        const kids = src.children.map((k) => { const cl = cloneNode(k, n); walk(cl, (x) => { x.substitutedFrom = tag; if (!x.file) x.file = c.file; }); return cl; });
        n.children.splice(i, 1, ...kids);
        i--;          // revisit the spliced children
        continue;
      }
      for (const a of SUBST_ATTRS) c.attrs.delete(a);
      if (c.attrs.has('replace')) { c.children = []; c.text = null; c.attrs.delete('replace'); }
      if (src.children.length) {
        c.children.push(...src.children.map((k) => { const cl = cloneNode(k, c); walk(cl, (x) => { if (!x.file) x.file = c.file; }); return cl; }));
        if (c.text != null && !c.text.trim()) c.text = null;
      } else if (src.text != null) {
        c.text = (c.text ?? '') + src.text;    // text nodes are appended, as importNode/appendChild does
        c.textLine = c.textLine || c.line;
      }
      for (const [k, v] of src.attrs || []) c.attrs.set(k, { ...v });
      c.substitutedFrom = tag;
      visit(c);
    }
  };
  visit(root);
  return findings;
}

/** Parse "KEY=value" lines; lines starting with "/" are ZooKeeper paths. */
export function parseSubstitutions(text) {
  const env = new Map(), zk = new Map();
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim(), v = t.slice(i + 1);
    (k.startsWith('/') ? zk : env).set(k, v);
  }
  return { env, zk };
}

export { makeNode };
