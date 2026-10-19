// References between sections: names used in one place that must be defined in another (macros in replicated
// paths, storage policies and disks). A name defined in a config.d file that isn't loaded shows up here,
// so the wording says "this config".

import { child, childrenNamed, textOf, getPath } from '../tree.js';
import { ref, SRC } from '../docs.js';
import { suggest } from '../types.js';
import { SYSTEM_LOGS } from './constants.js';

// Names used in one place that must be defined in another: macros in replicated paths, storage policies
// and disks. A name defined in a config.d file that isn't loaded shows up here, so the wording says "this config".
const SPECIAL_MACROS = ['database', 'table', 'uuid'];

const macroNames = (v) => [...String(v).matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);

/** Macros used in replica paths and engines, storage policies and disks referenced from other sections. */
export function checkRefs(ctx) {
  const { cfg, add } = ctx;
  if (ctx.mode === 'users') return;
  const mref = ref.server('macros'),
    msrc = ref.source(SRC.macros, 'Macros.cpp');
  const macrosEl = child(cfg, 'macros');
  const macrosOpaque = macrosEl && (ctx.hasSubst(macrosEl) || macrosEl.children.some((c) => c.name === 'include'));
  const macros = new Set(macrosEl ? macrosEl.children.map((c) => c.name) : []);
  let special = true;
  if (macrosEl)
    for (const m of macrosEl.children)
      if (SPECIAL_MACROS.includes(m.name)) {
        special = false;
        add(
          'warning',
          'macro-special',
          m,
          `Macro <${m.name}> has a special meaning. Defining it turns off the implicit {database}, {table} and {uuid} expansion in replicated table paths; ClickHouse logs a warning at startup.`,
          [mref, msrc],
        );
      }
  const builtin = (name) => name === 'server_uuid' || (special && SPECIAL_MACROS.includes(name));
  if (!macrosOpaque) {
    const sites = [];
    for (const k of ['default_replica_path', 'default_replica_name']) {
      const n = child(cfg, k);
      if (n && textOf(n) && !ctx.hasSubst(n)) sites.push({ n, what: `<${k}>`, docs: ref.server(k) });
    }
    for (const name of SYSTEM_LOGS) {
      const e = getPath(cfg, `${name}.engine`);
      if (e && textOf(e) && !ctx.hasSubst(e))
        sites.push({ n: e, what: `<${name}><engine>`, docs: ref.server(name), startup: true });
    }
    for (const { n, what, docs, startup } of sites) {
      const missing = [...new Set(macroNames(textOf(n)).filter((m) => !builtin(m) && !macros.has(m)))];
      if (missing.length)
        add(
          'warning',
          'macro-undefined',
          ctx.valueNode(n),
          `${what} uses ${missing.map((m) => `{${m}}`).join(', ')}, but <macros> in this config doesn't define ${missing.length > 1 ? 'them' : 'it'}. ${startup ? 'Creating the log table fails' : 'Creating a ReplicatedMergeTree table without explicit paths (outside a Replicated database) fails'} with "No macro '${missing[0]}' in config".`,
          [docs, mref, msrc],
        );
    }
    // Defaults: /clickhouse/tables/{uuid}/{shard} and {replica}. Only flagged when <macros> is present but incomplete.
    if (macrosEl && macrosEl.children.length && (child(cfg, 'zookeeper') || child(cfg, 'keeper_server'))) {
      const implicit = [];
      if (!child(cfg, 'default_replica_path') && !macros.has('shard')) implicit.push('shard');
      if (!child(cfg, 'default_replica_name') && !macros.has('replica')) implicit.push('replica');
      if (implicit.length)
        add(
          'info',
          'macro-default-missing',
          macrosEl,
          `<macros> doesn't define ${implicit.map((m) => `{${m}}`).join(' or ')}, which the default replica path (/clickhouse/tables/{uuid}/{shard}, replica {replica}) uses. ReplicatedMergeTree tables created without explicit paths will fail with "No macro '${implicit[0]}' in config".`,
          [ref.server('default_replica_path'), mref],
        );
    }
  }

  // Storage policies and disks.
  const sc = child(cfg, 'storage_configuration');
  if (sc && ctx.hasSubst(sc)) return;
  const policiesEl = sc && child(sc, 'policies');
  const disksEl = sc && child(sc, 'disks');
  if ((policiesEl && ctx.hasSubst(policiesEl)) || (disksEl && ctx.hasSubst(disksEl))) return;
  const policies = new Map([['default', null], ...(policiesEl ? policiesEl.children.map((p) => [p.name, p]) : [])]);
  const disks = new Set(['default', ...(disksEl ? disksEl.children.map((d) => d.name) : [])]);
  const sref = ref.server('storage_configuration');
  const known = (set) => [...set].map((x) => `'${x}'`).join(', ');
  const usePolicy = (n, what, consequence, sev = 'warning', docs = sref) => {
    const v = n && !ctx.hasSubst(n) && textOf(n);
    if (!v || policies.has(v)) return;
    const s = suggest(v, [...policies.keys()]);
    add(
      sev,
      'policy-undefined',
      ctx.valueNode(n),
      `${what} uses storage policy '${v}', which this config doesn't define${s ? `; did you mean '${s.name}'?` : ` (defined: ${known(policies.keys())})`}. ${consequence}`,
      [docs, sref],
    );
  };
  const useDisk = (n, what, consequence, sev = 'warning', docs = sref) => {
    const v = n && !ctx.hasSubst(n) && textOf(n);
    if (!v || disks.has(v)) return;
    const s = suggest(v, [...disks]);
    add(
      sev,
      'disk-undefined',
      ctx.valueNode(n),
      `${what} uses disk '${v}', which this config doesn't define${s ? `; did you mean '${s.name}'?` : ` (defined: ${known(disks)})`}. ${consequence}`,
      [docs, sref],
    );
  };
  const tmp = child(cfg, 'tmp_policy');
  usePolicy(tmp, '<tmp_policy>', 'The server fails to start (UNKNOWN_POLICY).', 'error', ref.server('tmp_policy'));
  const tp = tmp && policies.get(textOf(tmp));
  if (tp) {
    const vols = child(tp, 'volumes');
    if (vols && vols.children.length !== 1)
      add(
        'error',
        'tmp-policy-volumes',
        ctx.valueNode(tmp),
        `Storage policy '${textOf(tmp)}' has ${vols.children.length} volumes; a policy used for temporary files must have exactly one, or the server fails to start.`,
        [ref.server('tmp_policy'), ref.source(SRC.context, 'Context.cpp (setTemporaryStoragePolicy)')],
      );
  }
  if (!tmp || !textOf(tmp))
    useDisk(
      child(cfg, 'temporary_data_in_cache'),
      '<temporary_data_in_cache>',
      'The server fails to start (UNKNOWN_DISK).',
      'error',
      ref.server('temporary_data_in_cache'),
    );
  usePolicy(
    getPath(cfg, 'merge_tree.storage_policy'),
    '<merge_tree><storage_policy>',
    'Creating MergeTree tables that rely on this default fails with UNKNOWN_POLICY.',
    'warning',
    ref.mergeTree('storage_policy'),
  );
  for (const name of SYSTEM_LOGS)
    usePolicy(
      getPath(cfg, `${name}.storage_policy`),
      `<${name}>`,
      `Creating ${name} fails with UNKNOWN_POLICY, so it stays empty.`,
      'warning',
      ref.server(name),
    );
  for (const n of childrenNamed(child(cfg, 'backups') || { children: [] }, 'allowed_disk'))
    useDisk(
      n,
      '<backups><allowed_disk>',
      "BACKUP … TO Disk('…') with that disk fails.",
      'warning',
      ref.server('backups'),
    );
}
