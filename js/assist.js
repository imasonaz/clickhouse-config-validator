// Editor assistance: what element the cursor is in, which keys are valid there, and the documentation for a key.

import { ref } from './docs.js';
import { KEEPER_KEYS, USER_KEYS, SYSTEM_LOGS } from './validate.js';

/** Element path enclosing `offset` (XML: open-tag stack; YAML: indentation). Returns ['logger'] etc., excluding the root. */
export function contextPath(text, offset, fmt) {
  const before = text.slice(0, offset);
  if (fmt === 'yaml') {
    const lines = before.split('\n');
    const cur = lines.pop();
    let indent = cur.match(/^\s*/)[0].length;
    const path = [];
    for (let i = lines.length - 1; i >= 0 && indent > 0; i--) {
      const m = /^(\s*)(?:-\s+)?["']?([A-Za-z_][\w.\-]*)["']?\s*:\s*(#.*)?$/.exec(lines[i]);
      if (m && m[1].length < indent) { path.unshift(m[2]); indent = m[1].length; }
    }
    if (path[0] === 'clickhouse') path.shift();
    return path;
  }
  const stack = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.\-:]*)([^<>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(before))) {
    if (!m[2]) continue;
    if (m[1]) { const i = stack.lastIndexOf(m[2]); if (i >= 0) stack.length = i; }
    else if (!m[4]) stack.push(m[2]);
  }
  if (stack[0] === 'clickhouse' || stack[0] === 'yandex') stack.shift();
  return stack;
}

// Collapse user-chosen names so a path can be compared with the reference config.
const norm = (path) => {
  const p = [...path];
  if (p[0] === 'profiles' && p.length >= 2) p[1] = '*';
  if (p[0] === 'users' && p.length >= 2) p[1] = '*';
  if (p[0] === 'remote_servers' && p.length >= 2) p[1] = '*';
  if (p[0] === 'storage_configuration' && (p[1] === 'disks' || p[1] === 'policies') && p.length >= 3) p[2] = '*';
  return p;
};

/** Where a key lives and its definition: { scope, def, url } or null. */
export function lookup(schema, path, name) {
  const p = norm(path);
  const at = p.join('.');
  if (at === 'profiles.*' && (schema.session[name] || schema.sessionAliases[name])) {
    const n = schema.session[name] ? name : schema.sessionAliases[name];
    return { scope: 'session setting', name: n, def: schema.session[n], url: ref.session(n).url };
  }
  if ((at === 'merge_tree' || at === 'replicated_merge_tree') && schema.mergeTree[name]) return { scope: 'MergeTree setting', name, def: schema.mergeTree[name], url: ref.mergeTree(name).url };
  if (at === 'keeper_server.coordination_settings' && schema.coordination[name]) return { scope: 'Keeper coordination setting', name, def: schema.coordination[name], url: ref.keeperCoordination().url };
  if (at === 'keeper_server' && KEEPER_KEYS[name]) return { scope: 'Keeper setting', name, def: { t: KEEPER_KEYS[name].t || '', d: '' }, url: ref.keeper().url };
  if (at === 'users.*' && USER_KEYS.includes(name)) return { scope: 'user property', name, def: { t: '', d: '' }, url: ref.users().url };
  if (!p.length && schema.server[name]) return { scope: 'server setting', name, def: schema.server[name], url: ref.server(name).url };
  const dotted = [...path, name].join('.');
  const wp = Object.values(schema.serverWithPath).find((s) => s.path === dotted);
  if (wp) return { scope: 'server setting', name: dotted, def: wp, url: ref.server(path[0] || name).url };
  if (!p.length && schema.docPaths[name]) return { scope: 'server setting', name, def: { t: '', d: '' }, url: ref.server(name).url };
  if (candidates(schema, path).includes(name)) {
    const top = path[0] || name;
    const keeper = top === 'keeper_server';
    return { scope: keeper ? 'Keeper key' : path.length ? `key in <${path.at(-1)}>` : 'server key', name: [...path, name].join('.'), def: { t: '', d: '' }, url: keeper ? ref.keeper().url : ref.server(top).url };
  }
  return null;
}

/** Candidate child keys for a context path, best first. */
export function candidates(schema, path) {
  const p = norm(path);
  const at = p.join('.');
  if (at === 'profiles.*') return Object.keys(schema.session).filter((k) => !schema.session[k].obsolete);
  if (at === 'merge_tree' || at === 'replicated_merge_tree') return Object.keys(schema.mergeTree).filter((k) => !schema.mergeTree[k].obsolete);
  if (at === 'keeper_server.coordination_settings') return Object.keys(schema.coordination).filter((k) => !schema.coordination[k].obsolete);
  if (at === 'keeper_server') return Object.keys(KEEPER_KEYS);
  if (at === 'users.*') return [...USER_KEYS];
  const out = new Set();
  if (!p.length) {
    for (const [k, v] of Object.entries(schema.server)) if (!v.obsolete) out.add(k);
    for (const s of Object.values(schema.serverWithPath)) out.add(s.path.split('.')[0]);
    for (const k of ['profiles', 'users', 'quotas', 'merge_tree', 'remote_servers', 'zookeeper', 'keeper_server', 'storage_configuration', 'macros', 'include_from', ...SYSTEM_LOGS]) out.add(k);
  }
  for (const s of Object.values(schema.serverWithPath)) {
    const segs = s.path.split('.');
    if (segs.length === p.length + 1 && segs.slice(0, -1).join('.') === at) out.add(segs.at(-1));
  }
  for (const rp of [...schema.refPaths.server, ...schema.refPaths.keeper]) {
    const segs = norm(rp.split('.'));
    if (segs.length > p.length && segs.slice(0, p.length).join('.') === at && segs[p.length] !== '*') out.add(segs[p.length]);
  }
  return [...out];
}

/** Rank candidates for a typed prefix: prefix matches first, then substring matches. */
export function complete(schema, path, prefix, limit = 12) {
  const all = candidates(schema, path);
  const q = prefix.toLowerCase();
  const starts = all.filter((k) => k.toLowerCase().startsWith(q)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const inside = q.length >= 2 ? all.filter((k) => !k.toLowerCase().startsWith(q) && k.toLowerCase().includes(q)).sort() : [];
  return [...starts, ...inside].slice(0, limit);
}
