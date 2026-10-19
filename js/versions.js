// Setting lifecycle from the history records in Settings.cpp / MergeTreeSettings.cpp:
// h = [[version, previous_default, new_default, reason], ...], newest first.

export const cmpVer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Release the setting first appeared in: from the per-release index (tools/releases.py) when present,
 *  else from its oldest history record. 'next' = not in any release yet. */
export function addedIn(def) {
  if (def.since) return def.since;
  const h = def.h;
  if (!h || !h.length) return null;
  const oldest = h[h.length - 1];
  return /\bnew setting\b|\badded\b|\bintroduced\b/i.test(oldest[3]) ? oldest[0] : null;
}

/** Version and reason of the record that made the setting obsolete. */
export function obsoleteSince(def) {
  if (!def.obsolete || !def.h) return null;
  const r = def.h.find((x) => /obsolete|no effect|removed|deprecated/i.test(x[3]));
  return r ? { version: r[0], reason: r[3] } : null;
}

/** Default value at a given version ('latest' = the generated schema's default). */
export function defaultAt(def, version) {
  if (!version || version === 'latest' || !def.h || !def.h.length) return def.d;
  let v = null;
  for (let i = def.h.length - 1; i >= 0; i--) {
    const [ver, prev, next] = def.h[i];
    if (v === null) v = prev;
    if (cmpVer(ver, version) <= 0) v = next;
  }
  // History values are C++ literals; keep the schema's spelling when they agree numerically.
  return v === def.h[0][2] ? def.d : v;
}

/** Default changes (not "new setting" records), newest first: [{ version, from, to, reason }]. */
export function defaultChanges(def) {
  return (def.h || []).filter((r) => r[1] !== r[2] && !/\bnew setting\b/i.test(r[3])).map(([version, from, to, reason]) => ({ version, from, to, reason }));
}

/** [first, last] release of a setting that is no longer declared, or null. first = null: in the oldest indexed release. */
export function removedRange(schema, scope, name) {
  return schema.removed?.[scope]?.[name] || null;
}

/** Releases to offer as targets, newest first. */
export function knownVersions(schema) {
  if (schema.releases) return [...schema.releases].reverse();
  const s = new Set();
  for (const group of [schema.session, schema.mergeTree]) for (const d of Object.values(group)) for (const r of d.h || []) if (/^\d+\.\d+$/.test(r[0])) s.add(r[0]);
  return [...s].sort((a, b) => cmpVer(b, a));
}
