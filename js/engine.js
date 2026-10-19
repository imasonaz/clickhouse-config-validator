// Entry point shared by the UI and the tests: detect format, parse, validate.

import { parseXml, XmlError } from './xml.js';
import { parseYaml, YamlError } from './tree.js';
import { validate } from './validate.js';
import { setSchema, ref, SRC } from './docs.js';
import { planFiles, mergeDocs, applySubstitutions, tagFile, parseSubstitutions } from './merge.js';
import { child, textOf } from './tree.js';
import { crossCheck } from './cluster.js';

export function detectFormat(text) {
  const t = text.replace(/^﻿/, '').trimStart();
  return t.startsWith('<') ? 'xml' : 'yaml';
}

export function analyze(text, { schema, mode = 'auto', format = 'auto', version = 'latest', featureTier = null } = {}) {
  setSchema(schema);
  const fmt = format === 'auto' ? detectFormat(text) : format;
  const src = text.replace(/^﻿/, '');
  if (!src.trim()) return { format: fmt, doc: null, findings: [], mode, recognized: [], empty: true };
  let doc;
  try {
    doc = fmt === 'xml' ? parseXml(src) : parseYaml(src);
  } catch (e) {
    if (e instanceof XmlError || e instanceof YamlError) {
      const refs = fmt === 'xml'
        ? [ref.configFiles(null, 'Configuration files'), { label: 'XML 1.0 well-formedness', url: 'https://www.w3.org/TR/xml/#sec-well-formed' }]
        : [ref.configFiles('example-1', 'YAML examples'), { label: 'YAML 1.2 spec', url: 'https://yaml.org/spec/1.2.2/' }];
      return {
        format: fmt, doc: null, mode, recognized: [], parseError: true,
        findings: [{ sev: 'error', code: 'syntax', msg: `${fmt.toUpperCase()} syntax error: ${e.message}. ClickHouse cannot load this file.`, line: e.line || 1, col: e.col || 1, path: '', refs }],
      };
    }
    throw e;
  }
  const res = validate(doc, { schema, mode, format: fmt, version, featureTier });
  return { format: fmt, doc, ...res };
}

// ---------------------------------------------------------------- multi-file (config.d / users.d) analysis

// Findings that only make sense against the file as written (attributes and syntax vanish once merged).
const FILE_LOCAL = new Set(['syntax', 'root-yandex', 'root-name', 'yaml-explicit-root', 'yaml-dup-key', 'yaml-merge-key', 'yaml-complex-key', 'bad-name',
  'unknown-attr', 'multi-subst', 'yaml-attr', 'include-children', 'include-no-subst', 'replace-remove', 'replace-order', 'subst-has-value', 'mixed-content']);
const MAIN_NAMES = ['config.xml', 'config.yaml', 'config.yml', 'keeper_config.xml', 'keeper_config.yaml', 'keeper_config.yml', 'users.xml', 'users.yaml', 'users.yml'];
const fmtOf = (path, text, fmt) => (fmt && fmt !== 'auto' ? fmt : /\.ya?ml$/i.test(path) ? 'yaml' : /\.(xml|conf)$/i.test(path) ? 'xml' : detectFormat(text));
const inDotD = (path) => /(^|\/)[^/]+\.d\/[^/]+$/.test(path);

/** Files that can act as the main config: anything not inside a *.d directory. Well-known names first. */
export function mainCandidates(files) {
  const c = files.filter((f) => !inDotD(f.path));
  const rank = (p) => { const i = MAIN_NAMES.indexOf(p.slice(p.lastIndexOf('/') + 1)); return i < 0 ? 99 : i; };
  return c.sort((a, b) => rank(a.path) - rank(b.path)).map((f) => f.path);
}

/**
 * Analyse a set of files the way ClickHouse loads them: each file on its own, then the main file with its
 * config.d (or users.d) fragments merged in and substitutions applied, and the merged result validated.
 * files: [{ path, text }]. substitutions: "KEY=value" text (lines starting with '/' are ZooKeeper paths).
 */
export function analyzeSet(files, { schema, mode = 'auto', mainPath, substitutions = '', version = 'latest' } = {}) {
  setSchema(schema);
  // allow_feature_tier from any loaded server config also governs settings in users.xml profiles.
  let featureTier = null;
  for (const f of files) { const m = /<allow_feature_tier>\s*(\d)\s*<\/allow_feature_tier>|^allow_feature_tier:\s*(\d)\s*$/m.exec(f.text); if (m) featureTier = Number(m[1] ?? m[2]); }
  const perFile = new Map();
  for (const f of files) {
    const res = analyze(f.text, { schema, mode, format: fmtOf(f.path, f.text, f.format), version, featureTier });
    for (const x of res.findings) x.file = f.path;
    if (res.doc) tagFile(res.doc.root, f.path);
    perFile.set(f.path, res);
  }
  const cross = crossCheck([...perFile].filter(([, r]) => r.doc).map(([path, r]) => ({ path, doc: r.doc })));
  const mains = mainCandidates(files);
  mainPath = mains.includes(mainPath) ? mainPath : mains[0] || files[0]?.path;
  const main = perFile.get(mainPath);
  if (!main || !main.doc) return { mainPath, mains, perFile, cross, plan: [], events: [], findings: main ? [...main.findings, ...cross] : cross, recognized: [], mode: main?.mode || mode, merged: null };

  const effRoot = (d) => d.meta?.explicitClickhouseRoot ? { ...d.meta.explicitClickhouseRoot, name: 'clickhouse' } : d.root;
  const inc = child(effRoot(main.doc), 'include_from');
  const includeFrom = inc ? textOf(inc) : null;
  const plan = planFiles(files.map((f) => ({ path: f.path })), mainPath, includeFrom);
  // A loose file (no directory) of a different kind, e.g. keeper2.xml next to config.xml, is its own config, not a fragment.
  for (const p of plan) {
    const r = perFile.get(p.path);
    if (p.role === 'fragment' && !p.path.includes('/') && r.doc && r.mode !== main.mode && (r.mode === 'keeper' || main.mode === 'keeper')) {
      p.role = 'separate';
      p.reason = `looks like a separate ${r.mode} config; put it under config.d/ to merge it`;
    }
  }
  const docs = [{ path: mainPath, doc: { root: effRoot(main.doc) } }];
  for (const p of plan) if (p.role === 'fragment' && perFile.get(p.path).doc) docs.push({ path: p.path, doc: { root: effRoot(perFile.get(p.path).doc) } });
  const { root, events, findings: mergeFindings } = mergeDocs(docs);
  const incPlan = plan.find((p) => p.role === 'include');
  const incDoc = incPlan && perFile.get(incPlan.path).doc;
  const { env, zk } = parseSubstitutions(substitutions);
  const substFindings = applySubstitutions(root, { env, zk, includeRoot: incDoc ? effRoot(incDoc) : null, includePath: incPlan ? incPlan.path : includeFrom || '' });
  if (includeFrom && !incPlan && /\bincl=/.test(files.map((f) => f.text).join('\n')))
    mergeFindings.push({ sev: 'info', code: 'include-from-missing', file: mainPath, line: inc.line, msg: `<include_from> points to ${includeFrom}, which is not among the loaded files; incl substitutions are not resolved. Add that file to check them.` });

  const mergedDoc = { root, warnings: [], comments: [], prolog: [], meta: null };
  const res = validate(mergedDoc, { schema, mode: mode === 'auto' ? main.mode : mode, format: 'merged', version, featureTier });
  const all = [];
  const seen = new Set();
  const push = (f) => {
    const k = `${f.file}|${f.line}|${f.code}|${f.msg}`;
    if (seen.has(k)) return;
    seen.add(k);
    all.push({ refs: [], path: '', col: 1, ...f });
  };
  const used = new Set([mainPath, ...docs.map((d) => d.path), incPlan?.path].filter(Boolean));
  for (const [path, r] of perFile) if (used.has(path)) for (const f of r.findings) if (FILE_LOCAL.has(f.code) || r.parseError) push(f);
  for (const f of [...mergeFindings, ...substFindings]) push({ ...f, refs: f.refs || [ref.configFiles('merging', 'Merging configuration'), ref.source(SRC.configProcessor, 'ConfigProcessor.cpp')] });
  for (const f of res.findings) push({ ...f, file: f.file || mainPath });
  for (const f of cross) push(f);
  const rank = { error: 0, warning: 1, info: 2 };
  all.sort((a, b) => rank[a.sev] - rank[b.sev] || (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const mainsOut = mains.filter((m) => m !== incPlan?.path);
  return { mainPath, mains: mainsOut, perFile, cross, plan, events, findings: all, recognized: res.recognized, mode: res.mode, merged: mergedDoc, includeFrom };
}
