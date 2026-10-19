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

const identifier = (n) => n.name + '\u0000' + [...n.attrs].filter(([k]) => !IDENT_SKIP.has(k)).map(([k, v]) => `${k}=${v.value}`).sort().join('\u0000');

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
    const available = cfg.children.map((c) => ({ c, id: identifier(c), used: false }));
    for (const w of withNode.children) {
      const remove = w.attrs.has('remove');
      const replace = w.attrs.has('replace');
      if (remove && replace) {
        findings.push({ sev: 'error', code: 'replace-remove', file: path, line: w.line, msg: `Both remove and replace attributes set for element <${w.name}>; ClickHouse throws while merging.` });
        continue;
      }
      const wid = identifier(w);
      const match = available.find((a) => !a.used && a.id === wid);
      if (match) {
        match.used = true;
        const target = match.c;
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
