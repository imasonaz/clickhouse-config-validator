// Building blocks the section checks share: type checks against the generated schema, unknown-key reporting
// with "did you mean" and "valid in" hints, and setting lifecycle notes (obsolete, feature tier, version).

import { ref, SRC } from '../docs.js';
import { checkValue, suggest } from '../types.js';
import { isIPv4, isIPv6 } from '../net.js';
import {
  cmpVer,
  addedIn,
  obsoleteSince,
  defaultAt,
  defaultChanges,
  removedRange,
  tooNew,
  tierAt,
} from '../versions.js';
import { KEEPER_KEYS, USER_KEYS } from './constants.js';

/**
 * Check a leaf value against a schema type (e.g. 'UInt64', 'Bool', an enum name) and report a 'type' finding.
 * opts.parser: 'setting' (ClickHouse settings parsing, the default) or 'poco' (AbstractConfiguration getters).
 */
export function typeCheck(ctx, node, type, opts, refs) {
  if (ctx.hasSubst(node)) return;
  if (node.children.length) {
    if (type !== 'String')
      ctx.add(
        'error',
        'nesting',
        node,
        `<${node.name}> expects a ${type} value but contains child elements (${node.children
          .slice(0, 3)
          .map((c) => `<${c.name}>`)
          .join(', ')}${node.children.length > 3 ? ', …' : ''}).`,
        refs,
      );
    return;
  }
  const raw = node.text ?? '';
  if (raw.trim() === '' && type !== 'String') {
    ctx.add('error', 'empty', ctx.valueNode(node), `<${node.name}> is empty; expected ${type}.`, refs);
    return;
  }
  if ((opts?.parser ?? 'setting') === 'setting' && raw !== raw.trim() && type !== 'String' && raw.trim()) {
    ctx.add(
      'warning',
      'whitespace',
      ctx.valueNode(node),
      `Value of <${node.name}> has surrounding whitespace. ClickHouse setting parsers do not trim, so '${raw.replace(/\n/g, '\\n')}' may fail to parse; keep the value on one line with the tags.`,
      [...refs, ref.source(SRC.settingsParse, 'SettingsFieldsConversionHelpers.cpp')],
    );
  }
  const e = ctx.schema.enums[type];
  if (e && enumByRelease(ctx, node, e, raw, refs)) return;
  const r = checkValue(type, raw, { parser: opts?.parser, enums: ctx.schema.enums });
  if (r) ctx.add(r.sev, 'type', ctx.valueNode(node), `<${node.name}>: ${r.msg}`, [...refs, ...r.refs]);
}

/** Enum values that only some releases accept. Returns true when it reported the value (skip the usual check). */
function enumByRelease(ctx, node, e, raw, refs) {
  const items = (e.multi ? raw.split(',') : [raw]).map((x) => x.trim()).filter(Boolean);
  const vn = ctx.valueNode(node);
  const gone = items.filter((x) => !e.values.includes(x) && e.removed?.[x]);
  if (gone.length && items.every((x) => e.values.includes(x) || e.removed?.[x])) {
    for (const x of gone) {
      const [first, last] = e.removed[x];
      const span = first ? `${first} to ${last}` : `up to ${last}`;
      if (ctx.version !== 'latest' && cmpVer(ctx.version, last) <= 0 && (!first || cmpVer(ctx.version, first) >= 0))
        ctx.add(
          'info',
          'removed-later',
          vn,
          `<${node.name}>: '${x}' is accepted in ${ctx.version} but was removed after ${last} (releases ${span}); change it before upgrading.`,
          refs,
        );
      else
        ctx.add(
          'error',
          'removed-value',
          vn,
          `<${node.name}>: '${x}' was an allowed value in releases ${span} and has been removed. Allowed now: ${e.values
            .filter(Boolean)
            .map((v) => `'${v}'`)
            .join(', ')}.`,
          refs,
        );
    }
    return true;
  }
  if (ctx.version === 'latest') return false;
  for (const x of items) {
    const since = e.since?.[x];
    if (tooNew(since, ctx.version))
      ctx.add(
        'error',
        'version-too-new',
        vn,
        `<${node.name}>: '${x}' ${since === 'next' ? 'is not in any release yet' : `was added in ${since}`}; ${ctx.version} doesn't accept it.`,
        refs,
      );
  }
  return false;
}

/** Report a key that is not among `known`, with a "did you mean" suggestion and the places it would be valid. */
export function unknownChild(ctx, node, known, refs, { sev = 'warning', what = 'key' } = {}) {
  const s = suggest(node.name, known);
  if (s && s.caseOnly) {
    ctx.add(
      'error',
      'case',
      node,
      `'${node.name}' should be '${s.name}': ClickHouse configuration keys are case-sensitive.`,
      refs,
      { fix: { kind: 'rename', to: s.name } },
    );
    return;
  }
  const loc = s ? null : whereValid(ctx, node);
  ctx.add(
    s || loc ? 'warning' : sev,
    'unknown-key',
    node,
    `Unknown ${what} <${node.name}>${s ? `; did you mean <${s.name}>?` : '.'}${loc ? loc.msg : ''}`,
    [...refs, ...(loc ? loc.refs : [])],
    { fix: s ? { kind: 'rename', to: s.name } : loc ? { kind: 'move', to: loc.parents } : undefined },
  );
}

// Collapse user-chosen names (cluster, disk, user...) so paths compare by structure.
const normLoc = (p) =>
  p
    .replace(/^remote_servers\.[^.]+/, 'remote_servers.<cluster>')
    .replace(/^storage_configuration\.disks\.[^.]+/, 'storage_configuration.disks.<disk>')
    .replace(/^storage_configuration\.policies\.[^.]+/, 'storage_configuration.policies.<policy>')
    .replace(/^users\.[^.]+/, 'users.<user>')
    .replace(/^profiles\.[^.]+/, 'profiles.<profile>');

// Index of where each key name is valid: element name -> Map(parent path -> { label, ref }).
const LOC_CACHE = new WeakMap();

/** For each key name, the parent paths where it is valid (cached per schema). Drives "valid in" hints and move fixes. */
export function locationIndex(schema) {
  if (LOC_CACHE.has(schema)) return LOC_CACHE.get(schema);
  const idx = new Map();
  const put = (name, parent, label, r) => {
    if (!idx.has(name)) idx.set(name, new Map());
    const m = idx.get(name);
    if (!m.has(parent)) m.set(parent, { label, ref: r });
  };
  for (const name of Object.keys(schema.server)) put(name, '', 'server setting', () => ref.server(name));
  for (const s of Object.values(schema.serverWithPath)) {
    const segs = s.path.split('.');
    put(segs.pop(), segs.join('.'), 'server setting', () => ref.server(segs[0] || s.path));
  }
  for (const name of Object.keys(KEEPER_KEYS)) put(name, 'keeper_server', 'Keeper setting', () => ref.keeper());
  for (const name of Object.keys(schema.coordination))
    put(name, 'keeper_server.coordination_settings', 'Keeper coordination setting', () => ref.keeperCoordination());
  for (const name of Object.keys(schema.mergeTree)) {
    put(name, 'merge_tree', 'MergeTree setting', () => ref.mergeTree(name));
    put(name, 'replicated_merge_tree', 'MergeTree setting', () => ref.mergeTree(name));
  }
  for (const name of Object.keys(schema.session))
    put(name, 'profiles.<profile>', 'session setting', () => ref.session(name));
  for (const name of USER_KEYS) put(name, 'users.<user>', 'user property', () => ref.users());
  for (const [list, label] of [
    [schema.refPaths.server, 'server key'],
    [schema.refPaths.keeper, 'Keeper key'],
  ])
    for (const p of list) {
      const segs = p.split('.');
      const name = segs.pop();
      const parent = normLoc(segs.join('.'));
      put(name, parent, label, () => (parent.startsWith('keeper_server') ? ref.keeper() : ref.server(segs[0] || name)));
    }
  LOC_CACHE.set(schema, idx);
  return idx;
}

/** For an unknown key, name the places where a key of that name is valid (when there are few enough to be useful). */
export function whereValid(ctx, node) {
  const m = locationIndex(ctx.schema).get(node.name);
  if (!m) return null;
  const here = normLoc(ctx.relPath(node).slice(0, -1).join('.'));
  const cands = [...m].filter(([p]) => p !== here);
  if (!cands.length || cands.length > 4) return null;
  const show = (p) =>
    p
      ? p
          .split('.')
          .map((x) => (x.startsWith('<') ? x.replace(/^<(\w+)>$/, '<$1 name>') : `<${x}>`))
          .join(' › ')
      : 'the top level, directly under <clickhouse>';
  const msg =
    cands.length === 1
      ? ` It belongs at ${show(cands[0][0])} (${cands[0][1].label}); move it there.`
      : ` A key named <${node.name}> is valid at: ${cands.map(([p, v]) => `${show(p)} (${v.label})`).join('; ')}.`;
  const refs = [];
  for (const [, v] of cands) {
    const r = v.ref();
    if (!refs.some((x) => x.url === r.url)) refs.push(r);
  }
  return { msg, refs: refs.slice(0, 2), parents: cands.map(([p]) => p) };
}

const TIER = {
  experimental: { sev: 'warning', rank: 1, text: 'experimental: in active development and not for production use' },
  private_preview: {
    sev: 'warning',
    rank: 2,
    text: 'in private preview: on the path to general availability but not recommended for production yet',
  },
  beta: {
    sev: 'info',
    rank: 3,
    text: 'beta: no known bugs, but correctness together with other features is not guaranteed',
  },
};

const TIER_NAME = { experimental: 'experimental', private_preview: 'private preview', beta: 'beta' };

/** Obsolete, feature tier and version-availability notes for a recognised setting; also fixes up the
 *  overview row's default for the target version. kind: 'profile' | 'mergetree' marks settings whose
 *  unknown names stop the server from loading the config. */
export function lifecycle(ctx, node, what, name, def, docRef, kind = '') {
  const refs = [docRef];
  const row = ctx.recognized[ctx.recognized.length - 1];
  if (row && row.name.endsWith(name)) {
    row.def = defaultAt(def, ctx.version);
    const ch = defaultChanges(def);
    if (ch.length) row.hist = ch.map((c) => `${c.version}: ${c.from} → ${c.to}`).join('; ');
    const tr = tierAt(def, ctx.version);
    if (tr) row.tier = tr;
  }
  const o = def.obsolete ? obsoleteSince(def) : null;
  if (def.obsolete && (ctx.version === 'latest' || !o || cmpVer(o.version, ctx.version) <= 0)) {
    ctx.add(
      'warning',
      'obsolete',
      node,
      `<${node.name}> is an obsolete ${what}${o ? ` (since ${o.version})` : ''} and has no effect; remove it.${o && !/^obsolete setting\.?$/i.test(o.reason) ? ` Reason: ${o.reason}` : ''}`,
      refs,
    );
    return;
  }
  const added = addedIn(def);
  if (ctx.version !== 'latest' && added && (added === 'next' || cmpVer(added, ctx.version) > 0)) {
    const fail =
      kind === 'profile'
        ? 'loading the users config fails with UNKNOWN_SETTING'
        : kind === 'mergetree' || kind === 'coordination'
          ? `${kind === 'coordination' ? 'Keeper' : 'the server'} refuses to start (UNKNOWN_SETTING)`
          : 'it is ignored';
    const when = added === 'next' ? 'is not in any release yet (only in the master sources)' : `was added in ${added}`;
    ctx.add(
      fail === 'it is ignored' ? 'warning' : 'error',
      'version-too-new',
      node,
      `<${node.name}> ${when}; on ${ctx.version} it doesn't exist, so ${fail}.`,
      refs,
    );
  }
  const tier = tierAt(def, ctx.version);
  if (tier && !def.obsolete) {
    const t = TIER[tier];
    const atTarget =
      ctx.version !== 'latest' && tier !== (def.tier || null)
        ? ` in ${ctx.version}${def.tier ? ` (${TIER_NAME[def.tier]} in later releases)` : ' (generally available in later releases)'}`
        : '';
    ctx.add(t.sev, `tier-${tier.replace('_', '-')}`, node, `<${node.name}> is ${t.text}${atTarget}.`, [
      ...refs,
      ref.server('allow_feature_tier'),
    ]);
    if ((kind === 'profile' || kind === 'mergetree') && ctx.tierLimit != null && ctx.tierLimit >= t.rank)
      ctx.add(
        'warning',
        'tier-blocked',
        node,
        `allow_feature_tier is ${ctx.tierLimit}, which rejects changes to ${TIER_NAME[tier]} settings like <${node.name}> (it acts like a readonly constraint on them).`,
        [ref.server('allow_feature_tier')],
      );
  }
}

/** For a name that isn't declared any more: whether the target version still has it, and the message to use.
 *  Returns false when the setting never existed in an indexed release. */
export function removedSetting(ctx, scope, node, what, consequence, refs) {
  const r = removedRange(ctx.schema, scope, node.name);
  if (!r) return false;
  const [first, last] = r;
  const span = first ? `${first} to ${last}` : `up to ${last}`;
  if (ctx.version !== 'latest' && cmpVer(ctx.version, last) <= 0 && (!first || cmpVer(ctx.version, first) >= 0)) {
    ctx.add(
      'info',
      'removed-later',
      node,
      `<${node.name}> is a ${what} in ${ctx.version} but was removed after ${last} (present in releases ${span}). Remove it before upgrading: ${consequence}.`,
      refs,
    );
  } else {
    ctx.add(
      consequence.startsWith('it is ignored') ? 'warning' : 'error',
      'removed-setting',
      node,
      `<${node.name}> was a ${what} in releases ${span} and has been removed, so ${consequence}.`,
      refs,
    );
  }
  return true;
}

/** The docs anchor key for a nested server setting path, falling back to its top-level section. */
export function docKeyForPath(schema, path, name) {
  const top = path.split('.')[0];
  if (schema.docPaths[path]) return path;
  if (schema.docPaths[name]) return name;
  return top;
}

/** Poco boolean truthiness: true/yes/on or a non-zero integer. */
export function isTrue(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(s)) return true;
  if (/^[+-]?\d+$/.test(s)) return Number(s) !== 0;
  return false;
}

/** An IPv4/IPv6 address, optionally with a /prefix or a dotted netmask, as users.xml <networks><ip> accepts. */
export function validIpOrCidr(v) {
  const [addr, bits, ...rest] = v.split('/');
  if (rest.length) return false;
  const v4 = isIPv4(addr);
  const v6 = !v4 && isIPv6(addr);
  if (!v4 && !v6) return false;
  if (bits === undefined) return true;
  if (/^\d+$/.test(bits)) return Number(bits) <= (v4 ? 32 : 128);
  return v4 && isIPv4(bits); // netmask form
}
