// Upgrade report: what changes for this config when moving from one ClickHouse release to another.
// Runs the full check at both versions and compares the findings, then lists default and tier changes
// in between, for the settings the config sets and for those it leaves at their default.

import { analyze, analyzeSet } from './engine.js';
import { cmpVer, defaultChanges, tierAt } from './versions.js';

/** True when a change recorded at `v` lands after `from` and at or before `to` ('latest' = master). */
export function inRange(v, from, to) {
  if (v === 'next') return to === 'latest';
  if (!/^\d+(\.\d+)*$/.test(String(v))) return false;
  return cmpVer(v, from) > 0 && (to === 'latest' || cmpVer(v, to) <= 0);
}

const findingKey = (f) => `${f.file || ''}|${f.code}|${f.line}|${f.path || ''}`;

function defFor(schema, scope, name) {
  if (scope === 'server') return { def: schema.server[name] || schema.serverWithPath[name], group: 'server' };
  if (scope === 'coordination') return { def: schema.coordination[name.replace(/^coordination_settings\./, '')], group: 'coordination' };
  if (scope.startsWith('profile ')) return { def: schema.session[name], group: 'session' };
  if (scope === 'merge_tree' || scope === 'replicated_merge_tree') return { def: schema.mergeTree[name], group: 'mergeTree' };
  return { def: null };
}

const GROUPS_FOR_MODE = { server: ['server', 'mergeTree', 'session'], users: ['session'], keeper: ['coordination'] };
export const GROUP_LABEL = { server: 'Server settings', mergeTree: 'MergeTree settings', session: 'Session settings (profiles)', coordination: 'Keeper coordination settings' };

/**
 * files: [{ path, text, format? }]. Returns { from, to, mode, added, resolved, set, unset } where added/resolved are
 * findings that appear/disappear at `to`, set lists changes to settings the config sets, and unset maps a
 * settings group to default changes for settings the config does not set.
 */
export function upgradeReport(files, { schema, from, to, mode = 'auto', mainPath, substitutions = '' }) {
  const runAt = (version) => {
    if (files.length === 1) {
      const r = analyze(files[0].text, { schema, mode, format: files[0].format || 'auto', version });
      for (const f of r.findings) f.file = f.file || files[0].path;
      return r;
    }
    return analyzeSet(files, { schema, mode, mainPath, substitutions, version });
  };
  const a = runAt(from), b = runAt(to);
  if (a.parseError || b.parseError || (!a.doc && !a.merged)) return { from, to, error: 'Fix the syntax error first; the upgrade report needs a parseable config.' };
  const before = new Map(a.findings.map((f) => [findingKey(f), f]));
  const after = new Map(b.findings.map((f) => [findingKey(f), f]));
  // A finding present at both versions but with a different severity (e.g. an ignored key that becomes fatal)
  // counts as new when it got worse and as resolved when it got milder; `was` keeps the old severity.
  const rank = { error: 0, warning: 1, info: 2 };
  const added = [], resolved = [];
  for (const f of b.findings) {
    const o = before.get(findingKey(f));
    if (!o) added.push(f);
    else if (rank[f.sev] < rank[o.sev]) added.push({ ...f, was: o.sev });
  }
  for (const f of a.findings) {
    const n = after.get(findingKey(f));
    if (!n) resolved.push(f);
    else if (rank[n.sev] > rank[f.sev]) resolved.push({ ...n, was: f.sev });
  }

  const set = [];
  const setNames = { server: new Set(), mergeTree: new Set(), session: new Set(), coordination: new Set() };
  for (const r of b.recognized || []) {
    const { def, group } = defFor(schema, r.scope, r.name);
    if (!def) continue;
    setNames[group].add(group === 'coordination' ? r.name.replace(/^coordination_settings\./, '') : r.name);
    const changes = defaultChanges(def).filter((c) => inRange(c.version, from, to));
    const t0 = tierAt(def, from), t1 = tierAt(def, to);
    if (!changes.length && t0 === t1) continue;
    set.push({ scope: r.scope, name: r.name, value: r.value, file: r.file, line: r.line, url: r.url, changes: changes.reverse(), tier: t0 !== t1 ? { from: t0 || 'production', to: t1 || 'production' } : null });
  }

  const unset = {};
  const m = b.mode || a.mode || 'server';
  for (const group of GROUPS_FOR_MODE[m] || GROUPS_FOR_MODE.server) {
    const rows = [];
    for (const [name, def] of Object.entries(schema[group] || {})) {
      if (setNames[group].has(name) || def.obsolete) continue;
      const changes = defaultChanges(def).filter((c) => inRange(c.version, from, to));
      if (changes.length) rows.push({ name, changes: changes.reverse(), desc: def.desc });
    }
    if (rows.length) unset[group] = rows.sort((x, y) => (x.name < y.name ? -1 : 1));
  }
  return { from, to, mode: m, added, resolved, set, unset };
}

/** Markdown rendering for download. */
export function upgradeMarkdown(r, { source = '' } = {}) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const loc = (f) => `${f.file ? `${f.file}:` : ''}${f.line}`;
  const chg = (cs) => cs.map((c) => `${c.version}: ${c.from} → ${c.to}`).join('; ');
  const out = [`# Upgrade report: ${r.from} → ${r.to}`, '', source ? `${source}` : '', ''];
  out.push(`## New findings at ${r.to} (${r.added.length})`, '');
  if (r.added.length) out.push('| Severity | Location | Finding |', '|---|---|---|', ...r.added.map((f) => `| ${f.sev}${f.was ? ` (was ${f.was})` : ''} | \`${cell(loc(f))}\` | ${cell(f.msg)} |`));
  else out.push('None.');
  out.push('', `## Resolved by ${r.to} (${r.resolved.length})`, '');
  if (r.resolved.length) out.push('| Severity | Location | Finding |', '|---|---|---|', ...r.resolved.map((f) => `| ${f.sev}${f.was ? ` (was ${f.was})` : ''} | \`${cell(loc(f))}\` | ${cell(f.msg)} |`));
  else out.push('None.');
  out.push('', `## Settings this config sets that changed (${r.set.length})`, '');
  if (r.set.length) out.push('| Setting | Your value | Default changes | Tier |', '|---|---|---|---|', ...r.set.map((s) => `| \`${cell(s.name)}\` (${cell(s.scope)}) | \`${cell(s.value)}\` | ${cell(chg(s.changes))} | ${s.tier ? `${s.tier.from} → ${s.tier.to}` : ''} |`));
  else out.push('None.');
  for (const [g, rows] of Object.entries(r.unset)) {
    out.push('', `## ${GROUP_LABEL[g]} left at default whose default changed (${rows.length})`, '', '| Setting | Default changes |', '|---|---|', ...rows.map((x) => `| \`${cell(x.name)}\` | ${cell(chg(x.changes))} |`));
  }
  return out.join('\n') + '\n';
}
