// Cross-file checks for a set of configs: Keeper ensemble consistency, and server <zookeeper> entries
// pointing at the Keeper nodes' client ports.

import { child, childrenNamed, textOf } from './tree.js';
import { ref, SRC } from './docs.js';

const cfgRoot = (doc) => (doc.meta?.explicitClickhouseRoot) || doc.root;
const num = (n) => { const v = n && textOf(n); return v && /^\d+$/.test(v.trim()) ? Number(v) : null; };

function keeperInfo(path, doc) {
  const ks = child(cfgRoot(doc), 'keeper_server');
  if (!ks) return null;
  const servers = [];
  const rc = child(ks, 'raft_configuration');
  for (const s of rc ? rc.children.filter((c) => c.name.startsWith('server')) : []) {
    servers.push({ id: num(child(s, 'id')), host: (textOf(child(s, 'hostname')) || '').trim(), port: num(child(s, 'port')), node: s });
  }
  const coord = new Map();
  for (const c of child(ks, 'coordination_settings')?.children || []) if (!c.children.length) coord.set(c.name, { value: (textOf(c) || '').trim(), node: c });
  return { path, ks, serverId: num(child(ks, 'server_id')), serverIdNode: child(ks, 'server_id'), tcpPort: num(child(ks, 'tcp_port')) ?? num(child(ks, 'tcp_port_secure')), rc, servers, coord };
}

const sig = (s) => `${s.id}@${s.host}:${s.port}`;

export function crossCheck(entries) {
  // entries: [{ path, doc }] for every file that parsed.
  const out = [];
  const kref = ref.keeper();
  const add = (sev, code, file, node, msg, refs = [kref]) => out.push({ sev, code, file, line: node?.textLine || node?.line || 1, col: 1, path: '', msg, refs });
  const keepers = entries.map(({ path, doc }) => keeperInfo(path, doc)).filter((k) => k && k.rc);

  if (keepers.length >= 2) {
    // server_id must be unique across the ensemble.
    const byId = new Map();
    for (const k of keepers) if (k.serverId != null) { if (!byId.has(k.serverId)) byId.set(k.serverId, []); byId.get(k.serverId).push(k); }
    for (const [id, ks] of byId) if (ks.length > 1)
      for (const k of ks.slice(1)) add('error', 'ensemble-dup-id', k.path, k.serverIdNode, `server_id ${id} is also used by ${ks[0].path}. Every Keeper node needs its own server_id.`);

    // raft_configuration should be the same on every node.
    const base = keepers[0];
    const baseSet = new Map(base.servers.map((s) => [s.id, s]));
    for (const k of keepers.slice(1)) {
      const mine = new Map(k.servers.map((s) => [s.id, s]));
      const diffs = [];
      for (const [id, s] of baseSet) {
        const o = mine.get(id);
        if (!o) diffs.push(`server ${id} (${s.host}:${s.port}) is missing`);
        else if (sig(o) !== sig(s)) diffs.push(`server ${id} is ${o.host}:${o.port} here but ${s.host}:${s.port} in ${base.path}`);
      }
      for (const [id, s] of mine) if (!baseSet.has(id)) diffs.push(`server ${id} (${s.host}:${s.port}) is not in ${base.path}`);
      if (diffs.length) add('error', 'ensemble-raft-diff', k.path, k.rc, `<raft_configuration> differs from ${base.path}: ${diffs.join('; ')}. All nodes must list the same servers, or they disagree about the quorum.`, [kref, ref.keeperQuorum()]);
    }

    // Each file's own server should match its entry: same id appears exactly once across the files.
    const listed = base.servers.map((s) => s.id);
    const have = new Set(keepers.map((k) => k.serverId));
    const missing = listed.filter((id) => !have.has(id));
    if (missing.length) add('info', 'ensemble-partial', base.path, base.rc, `No config is loaded for Keeper server id${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, so ${missing.length > 1 ? 'those nodes are' : 'that node is'} not cross-checked.`);

    // Coordination settings are normally identical across the ensemble; differing timeouts cause flapping leadership.
    const names = new Set(keepers.flatMap((k) => [...k.coord.keys()]));
    for (const name of names) {
      const vals = keepers.map((k) => ({ k, v: k.coord.get(name)?.value ?? '(default)' }));
      if (new Set(vals.map((x) => x.v)).size < 2) continue;
      const first = vals[0];
      for (const x of vals.slice(1)) if (x.v !== first.v) {
        const n = x.k.coord.get(name)?.node || x.k.ks;
        add(/election_timeout|heart_beat/.test(name) ? 'warning' : 'info', 'ensemble-coord-diff', x.k.path, n,
          `coordination_settings.${name} is ${x.v} here but ${first.v} in ${first.k.path}. Keep coordination settings the same on every node.`, [ref.keeperCoordination()]);
      }
    }
  }

  // Server <zookeeper> nodes must target Keeper's client port (tcp_port), not the Raft port.
  if (keepers.length) {
    const raftByHost = new Map();
    for (const k of keepers) for (const s of k.servers) {
      const e = raftByHost.get(s.host) || { ports: new Set(), keeper: null };
      e.ports.add(s.port);
      e.keeper = e.keeper || keepers.find((x) => x.serverId === s.id && x.servers.some((y) => y.host === s.host)) || null;
      raftByHost.set(s.host, e);
    }
    for (const { path, doc } of entries) {
      const zk = child(cfgRoot(doc), 'zookeeper');
      if (!zk) continue;
      for (const n of childrenNamed(zk, 'node')) {
        const host = (textOf(child(n, 'host')) || '').trim();
        const port = num(child(n, 'port')) ?? 2181;
        const r = raftByHost.get(host);
        if (!r) continue;
        if (r.ports.has(port)) add('error', 'zk-raft-port', path, child(n, 'port') || n, `<zookeeper> node ${host}:${port} points at Keeper's Raft port. ClickHouse must connect to the client port (keeper_server.tcp_port${r.keeper?.tcpPort ? `, ${r.keeper.tcpPort} in ${r.keeper.path}` : ''}).`, [ref.server('zookeeper'), kref]);
        else if (r.keeper?.tcpPort && port !== r.keeper.tcpPort) add('warning', 'zk-port-mismatch', path, child(n, 'port') || n, `<zookeeper> node ${host}:${port} doesn't match the Keeper client port ${r.keeper.tcpPort} configured in ${r.keeper.path}.`, [ref.server('zookeeper'), kref]);
      }
    }
  }
  return out;
}

export { SRC };
