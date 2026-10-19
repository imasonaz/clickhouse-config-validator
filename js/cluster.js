// Cross-file checks for a set of configs: Keeper ensemble consistency, server <zookeeper> entries
// pointing at the Keeper nodes' client ports, references into users files, and consistency between the
// merged configs of several server nodes.

import { child, childrenNamed, textOf, walk, getPath } from './tree.js';
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

const SUBST = ['incl', 'from_env', 'from_zk'];
const opaque = (n) => !!n && (SUBST.some((a) => n.attrs.has(a)) || n.children.some((c) => c.name === 'include'));
const val = (n) => (n && textOf(n) != null ? textOf(n).trim() : null);

/**
 * Names a server config takes from the users config: default_profile, system_profile, distributed_ddl.profile
 * and the user of each remote_servers replica. Checked only when a loaded file defines <profiles> / <users>.
 * entries: [{ path, doc }].
 */
export function crossRefs(entries) {
  const out = [];
  const roots = entries.map(({ path, doc }) => ({ path, root: cfgRoot(doc) }));
  const collect = (section) => {
    const names = new Set();
    let seen = false, unknown = false;
    for (const { root } of roots) {
      const el = child(root, section);
      if (!el) continue;
      seen = true;
      if (opaque(el)) unknown = true;
      for (const c of el.children) if (c.name !== 'include') names.add(c.name);
    }
    return seen && !unknown ? names : null;
  };
  const profiles = collect('profiles'), users = collect('users');
  const uref = ref.users('user-nameprofile', 'Users: profile');
  const add = (sev, code, file, node, msg, refs) => out.push({ sev, code, file: node?.file || file, line: node?.textLine || node?.line || 1, col: 1, path: '', msg, refs });
  const where = roots.length > 1 ? 'any loaded users file' : 'this file';
  for (const { path, root } of roots) {
    if (child(root, 'keeper_server') && !child(root, 'remote_servers') && !child(root, 'tcp_port')) continue;
    const isServer = ['tcp_port', 'http_port', 'remote_servers', 'path', 'logger', 'macros', 'zookeeper', 'default_profile', 'system_profile'].some((k) => child(root, k));
    if (!isServer) continue;
    if (profiles) {
      for (const [key, dflt, msg] of [['default_profile', 'default', (v) => `Settings profile \`${v}\` not found`], ['system_profile', 'default', (v) => `There is no settings profile \`${v}\` in \`user directories\``]]) {
        const n = child(root, key);
        if (n && opaque(n)) continue;
        const v = n ? val(n) : dflt;
        if (!v || profiles.has(v)) continue;
        add(n ? 'error' : 'warning', 'ref-profile', path, n || root, `${n ? `<${key}> is '${v}'` : `<${key}> is not set, so it is '${dflt}'`}, but no profile with that name is defined in ${where} (profiles: ${[...profiles].join(', ') || 'none'}). The server fails to start with "${msg(v)}" (THERE_IS_NO_PROFILE; verified with 26.9).`, [ref.server(key), uref]);
      }
      const ddl = getPath(root, 'distributed_ddl.profile');
      if (ddl && !opaque(ddl) && val(ddl) && !profiles.has(val(ddl)))
        add('warning', 'ref-profile', path, ddl, `<distributed_ddl><profile> is '${val(ddl)}', which no loaded users file defines. ON CLUSTER queries fail on this node.`, [ref.server('distributed_ddl'), uref]);
    }
    if (users) {
      const rs = child(root, 'remote_servers');
      for (const cl of rs && !opaque(rs) ? rs.children : []) {
        if (child(cl, 'secret')) continue;   // with a secret the initial user is passed through instead
        walk(cl, (n) => {
          if (!n.name.startsWith('replica') && !n.name.startsWith('node')) return;
          if (!child(n, 'host')) return;
          const u = child(n, 'user');
          if (u && opaque(u)) return;
          const v = u ? val(u) : 'default';
          if (v && !users.has(v)) add('warning', 'ref-cluster-user', path, u || n, `Cluster '${cl.name}' connects as user '${v}'${u ? '' : ' (the default when <user> is not set)'}, which ${where} doesn't define. Distributed queries fail with "${v}: Authentication failed" unless the other nodes define it.`, [ref.server('remote_servers')]);
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- several server nodes

const SERVER_PORTS = ['tcp_port', 'tcp_port_secure', 'http_port', 'https_port', 'interserver_http_port', 'interserver_https_port', 'mysql_port', 'postgresql_port',
  'grpc_port', 'tcp_with_proxy_port', 'prometheus.port', 'keeper_server.tcp_port', 'keeper_server.tcp_port_secure'];

function clusterSig(cl) {
  const shards = cl.children.filter((c) => c.name.startsWith('shard') || c.name.startsWith('node')).map((sh) => {
    const reps = sh.name.startsWith('node') ? [sh] : sh.children.filter((r) => r.name.startsWith('replica'));
    return reps.map((r) => `${val(child(r, 'host')) || '?'}:${val(child(r, 'port')) || 'tcp_port'}`).join(', ');
  });
  return { shards, secret: !!child(cl, 'secret'), text: shards.map((s, i) => `shard ${i + 1}: ${s}`).join('; ') };
}

/**
 * Consistency between the merged configs of several ClickHouse server nodes (nodes: [{ path, root }]):
 * the same remote_servers clusters, unique shard/replica macros, the same ZooKeeper, DDL queue and replica
 * paths, and the same interserver credentials.
 */
export function nodeCheck(nodes) {
  const out = [];
  if (nodes.length < 2) return out;
  const add = (sev, code, path, node, msg, refs) => out.push({ sev, code, file: node?.file || path, line: node?.textLine || node?.line || 1, col: 1, path: '', msg, refs });
  const sref = (k) => ref.server(k);
  const [base, ...rest] = nodes;
  const short = (p) => p;

  // remote_servers: a cluster with the same name must look the same everywhere.
  const clustersOf = (root) => {
    const rs = child(root, 'remote_servers');
    if (!rs || opaque(rs)) return null;
    return new Map(rs.children.filter((c) => c.name !== 'include' && !child(c, 'discovery') && !opaque(c)).map((c) => [c.name, { node: c, ...clusterSig(c) }]));
  };
  const all = nodes.map((n) => ({ ...n, clusters: clustersOf(n.root) }));
  const withClusters = all.filter((n) => n.clusters);
  if (withClusters.length >= 2) {
    const ref0 = withClusters[0];
    for (const n of withClusters.slice(1)) {
      for (const [name, c] of ref0.clusters) {
        const o = n.clusters.get(name);
        if (!o) { add('warning', 'node-cluster-missing', n.path, child(n.root, 'remote_servers'), `Cluster '${name}' is defined in ${short(ref0.path)} but not here. ON CLUSTER '${name}' queries and Distributed tables don't work from this node.`, [sref('remote_servers')]); continue; }
        if (o.text !== c.text) add('warning', 'node-cluster-diff', n.path, o.node, `Cluster '${name}' differs from ${short(ref0.path)}: here ${o.text || 'no shards'}; there ${c.text || 'no shards'}. Every node should describe the cluster the same way, or queries see different topologies depending on where they start.`, [sref('remote_servers')]);
        else if (o.secret !== c.secret) add('warning', 'node-cluster-secret', n.path, o.node, `Cluster '${name}' has a <secret> in ${o.secret ? 'this file' : short(ref0.path)} but not in ${o.secret ? short(ref0.path) : 'this file'}. Inter-server authentication must be configured the same on every node.`, [sref('remote_servers')]);
      }
      for (const [name, o] of n.clusters) if (!ref0.clusters.has(name)) add('info', 'node-cluster-missing', ref0.path, child(ref0.root, 'remote_servers'), `Cluster '${name}' is defined in ${short(n.path)} but not here.`, [sref('remote_servers')]);
    }
  }

  // macros: every node needs its own shard/replica pair, and the same macro names.
  const macrosOf = (root) => { const m = child(root, 'macros'); return !m || opaque(m) ? null : new Map(m.children.filter((c) => !c.children.length).map((c) => [c.name, { v: val(c) || '', node: c }])); };
  const ms = all.map((n) => ({ ...n, macros: macrosOf(n.root) })).filter((n) => n.macros);
  if (ms.length >= 2) {
    const keyOf = (m) => ['layer', 'shard', 'replica'].filter((k) => m.has(k)).map((k) => `${k}=${m.get(k).v}`).join(', ');
    const seen = new Map();
    for (const n of ms) {
      if (!n.macros.has('replica')) continue;
      const k = keyOf(n.macros);
      if (seen.has(k)) add('error', 'node-dup-replica', n.path, n.macros.get('replica').node, `Macros ${k} are the same as in ${short(seen.get(k).path)}. Each replica needs its own {replica} value within a shard; otherwise both nodes register the same replica path and the second fails with "Replica … already exists".`, [sref('macros')]);
      else seen.set(k, n);
    }
    const names = new Set(ms.flatMap((n) => [...n.macros.keys()]));
    for (const n of ms) {
      const missing = [...names].filter((k) => !n.macros.has(k));
      if (missing.length) add('warning', 'node-macro-missing', n.path, child(n.root, 'macros'), `<macros> here lacks ${missing.map((k) => `{${k}}`).join(', ')}, which other nodes define. ON CLUSTER DDL that uses ${missing.length > 1 ? 'them' : 'it'} fails on this node.`, [sref('macros')]);
    }
    for (const k of ['cluster', 'layer']) {
      const vals = ms.filter((n) => n.macros.has(k));
      const first = vals[0];
      for (const n of vals.slice(1)) if (n.macros.get(k).v !== first.macros.get(k).v)
        add('info', 'node-macro-diff', n.path, n.macros.get(k).node, `{${k}} is '${n.macros.get(k).v}' here but '${first.macros.get(k).v}' in ${short(first.path)}. It is normally the same on every node of a cluster.`, [sref('macros')]);
    }
    // {shard} should match the shard that lists this node's {replica} host in remote_servers.
    for (const n of ms) {
      const sh = n.macros.get('shard'), rp = n.macros.get('replica');
      if (!sh || !rp || !n.clusters) continue;
      for (const [cname, c] of n.clusters) {
        const idx = c.shards.findIndex((s) => s.split(', ').some((e) => e.split(':')[0] === rp.v));
        if (idx < 0) continue;
        const shNode = c.node.children.filter((x) => x.name.startsWith('shard') || x.name.startsWith('node'))[idx];
        const named = val(child(shNode, 'name'));
        const ok = named ? named === sh.v : /^\d+$/.test(sh.v) && Number(sh.v) === idx + 1;
        if (!ok && (named || /^\d+$/.test(sh.v))) add('warning', 'node-shard-mismatch', n.path, sh.node, `{shard} is '${sh.v}', but cluster '${cname}' lists this node's {replica} host (${rp.v}) in shard ${named ? `'${named}'` : idx + 1}. Replicated tables would join the wrong shard's replication queue.`, [sref('macros'), sref('remote_servers')]);
        break;
      }
    }
  }

  // Values that must agree across nodes.
  const zkSig = (root) => {
    const z = child(root, 'zookeeper');
    if (!z || opaque(z)) return null;
    const nodesL = childrenNamed(z, 'node').map((n) => `${val(child(n, 'host'))}:${val(child(n, 'port')) || 2181}`).sort();
    return { node: z, text: `${nodesL.join(', ')}${val(child(z, 'root')) ? ` root ${val(child(z, 'root'))}` : ''}` };
  };
  const same = (code, label, get, sev, why, refs, secret = false) => {
    const vals = nodes.map((n) => ({ n, s: get(n.root) })).filter((x) => x.s);
    if (vals.length < 2) return;
    const first = vals[0];
    for (const x of vals.slice(1)) if (x.s.text !== first.s.text)
      add(sev, code, x.n.path, x.s.node, `${label} ${secret ? `differs from ${short(first.n.path)}` : `is ${x.s.text || '(empty)'} here but ${first.s.text || '(empty)'} in ${short(first.n.path)}`}. ${why}`, refs);
  };
  const leaf = (p) => (root) => { const n = getPath(root, p); return n && !opaque(n) ? { node: n, text: val(n) || '' } : null; };
  same('node-zk-diff', '<zookeeper>', zkSig, 'warning', 'Nodes that replicate together must use the same ZooKeeper/Keeper ensemble and root.', [sref('zookeeper')]);
  same('node-ddl-diff', '<distributed_ddl><path>', leaf('distributed_ddl.path'), 'warning', 'Nodes with different DDL queue paths never see each other\'s ON CLUSTER queries.', [sref('distributed_ddl')]);
  same('node-replica-path-diff', '<default_replica_path>', leaf('default_replica_path'), 'warning', 'Replicas of the same table must resolve to the same path.', [sref('default_replica_path')]);
  same('node-interserver-user', '<interserver_http_credentials><user>', leaf('interserver_http_credentials.user'), 'error', 'Replicas authenticate to each other with these credentials; fetching parts fails with 401 when they differ.', [sref('interserver_http_credentials')]);
  same('node-interserver-password', '<interserver_http_credentials><password>', leaf('interserver_http_credentials.password'), 'error', 'Replicas authenticate to each other with these credentials; fetching parts fails with 401 when they differ.', [sref('interserver_http_credentials')], true);
  return out;
}

/** Ports a server config and a standalone Keeper config both open (they clash when run on one host). */
export function portOverlap(servers, keepers) {
  const out = [];
  const portsOf = (root, paths) => {
    const m = new Map();
    for (const p of paths) { const n = getPath(root, p); const v = val(n); if (v && /^\d+$/.test(v) && !opaque(n)) m.set(v, { p, n }); }
    return m;
  };
  for (const k of keepers) {
    const kp = portsOf(k.root, ['keeper_server.tcp_port', 'keeper_server.tcp_port_secure', 'keeper_server.http_control.port', 'prometheus.port']);
    const sid = val(getPath(k.root, 'keeper_server.server_id'));
    for (const s of getPath(k.root, 'keeper_server.raft_configuration')?.children || []) if (val(child(s, 'id')) === sid && val(child(s, 'port'))) kp.set(val(child(s, 'port')), { p: 'raft port', n: child(s, 'port') });
    for (const srv of servers) {
      const sp = portsOf(srv.root, SERVER_PORTS);
      for (const [v, x] of kp) if (sp.has(v)) out.push({ sev: 'info', code: 'node-port-overlap', file: x.n.file || k.path, line: x.n.textLine || x.n.line || 1, col: 1, path: '',
        msg: `Port ${v} is Keeper's ${x.p} here and <${sp.get(v).p}> in ${srv.path}. If both run on the same host, the second to start fails with "Address already in use".`, refs: [ref.keeper()] });
    }
  }
  return out;
}

export { SRC };
