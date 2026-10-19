// Distributed setup within one file: <remote_servers> (mirrors src/Interpreters/Cluster.cpp) and <zookeeper>.

import { child, childrenNamed, textOf, getPath } from '../tree.js';
import { ref, SRC } from '../docs.js';
import { ZK_LB } from './constants.js';
import { typeCheck, unknownChild } from './helpers.js';

/** <remote_servers>: cluster, shard and replica structure as Cluster.cpp enforces it. */
export function checkRemoteServers(ctx) {
  const rs = child(ctx.cfg, 'remote_servers');
  if (!rs || ctx.hasSubst(rs)) return;
  const { add } = ctx;
  const cref = ref.source(SRC.cluster, 'Cluster.cpp');
  const dref = ref.server('remote_servers');
  const hasTcpPort = !!getPath(ctx.cfg, 'tcp_port');
  for (const cl of rs.children) {
    if (cl.name === 'include') continue;
    if (cl.name.includes('.'))
      add('error', 'cluster-dot', cl, `Cluster names with dots are not supported: '${cl.name}'.`, [cref]);
    if (child(cl, 'discovery')) continue;
    const elems = cl.children.filter((c) => !['secret', 'allow_distributed_ddl_queries', 'include'].includes(c.name));
    if (!elems.length && !ctx.hasSubst(cl)) {
      add('error', 'cluster-empty', cl, `Cluster '${cl.name}' has no <shard> or <node> elements.`, [cref, dref]);
      continue;
    }
    const named = elems.filter((e) => child(e, 'name')).length;
    if (named && named !== elems.length)
      add(
        'error',
        'shard-names',
        cl,
        `Cluster '${cl.name}': <name> must be specified for every shard (node) or for none.`,
        [cref],
      );
    const adr = child(cl, 'allow_distributed_ddl_queries');
    if (adr) typeCheck(ctx, adr, 'Bool', { parser: 'poco' }, [dref]);
    for (const sh of elems) {
      if (!sh.name.startsWith('shard') && !sh.name.startsWith('node')) {
        add(
          'error',
          'cluster-elem',
          sh,
          `Unknown element in config: <${sh.name}> (cluster '${cl.name}' accepts only <shard>, <node>, <secret>, <allow_distributed_ddl_queries>).`,
          [cref, dref],
        );
        continue;
      }
      if (sh.name.startsWith('node')) {
        checkReplica(ctx, sh, hasTcpPort, cref, dref);
        continue;
      }
      let replicas = 0;
      for (const r of sh.children) {
        if (
          ['weight', 'internal_replication', 'name', 'include'].includes(r.name) ||
          r.name.startsWith('weight') ||
          r.name.startsWith('internal_replication') ||
          r.name.startsWith('name')
        ) {
          if (r.name === 'internal_replication') typeCheck(ctx, r, 'Bool', { parser: 'poco' }, [dref]);
          if (r.name === 'weight') typeCheck(ctx, r, 'UInt32', { parser: 'poco' }, [dref]);
          continue;
        }
        if (!r.name.startsWith('replica')) {
          add(
            'error',
            'shard-elem',
            r,
            `Unknown element in config: <${r.name}> (a <shard> accepts <replica>, <weight>, <internal_replication>, <name>).`,
            [cref],
          );
          continue;
        }
        replicas++;
        checkReplica(ctx, r, hasTcpPort, cref, dref);
      }
      if (!replicas) add('error', 'shard-empty', sh, 'Shard contains zero replicas.', [cref]);
    }
  }
}

function checkReplica(ctx, r, hasTcpPort, cref, dref) {
  const keys = [
    'host',
    'port',
    'user',
    'password',
    'secure',
    'compression',
    'priority',
    'default_database',
    'bind_host',
    'proto_caps',
    'quota_key',
  ];
  if (!child(r, 'host')) ctx.add('error', 'replica-host', r, `<${r.name}> is missing <host>.`, [cref, dref]);
  if (!child(r, 'port'))
    ctx.add(
      hasTcpPort ? 'info' : 'warning',
      'replica-port',
      r,
      `<${r.name}> has no <port>; it defaults to the server's tcp_port${hasTcpPort ? '' : ' (not set in this file); if that is unset, loading fails with "Port is not specified in cluster configuration"'}.`,
      [cref],
    );
  for (const c of r.children) {
    if (!keys.includes(c.name)) {
      unknownChild(ctx, c, keys, [dref], { sev: 'info' });
      continue;
    }
    if (c.name === 'port') typeCheck(ctx, c, 'Port', { parser: 'poco' }, [dref]);
    if (c.name === 'priority') typeCheck(ctx, c, 'Int32', { parser: 'poco' }, [dref]);
    if (c.name === 'secure' || c.name === 'compression') typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [dref]);
  }
}

/** <zookeeper> and <auxiliary_zookeepers>: endpoints, known keys and value types. */
export function checkZookeeper(ctx) {
  const zks = [];
  const z = child(ctx.cfg, 'zookeeper');
  if (z) zks.push(z);
  const aux = child(ctx.cfg, 'auxiliary_zookeepers');
  if (aux) zks.push(...aux.children);
  const zref = ref.server('zookeeper');
  const keys = [
    'node',
    'session_timeout_ms',
    'operation_timeout_ms',
    'connection_timeout_ms',
    'root',
    'identity',
    'zookeeper_load_balancing',
    'fallback_session_lifetime',
    'use_compression',
    'use_xid_64',
    'pass_opentelemetry_tracing_context',
    'secure',
    'implementation',
    'availability_zone_autodetect',
    'prefer_local_availability_zone',
    'send_receive_timeout_ms',
    'enable_fault_injections_during_startup',
    'send_fault_probability',
    'recv_fault_probability',
    'send_sleep_probability',
    'send_sleep_ms',
    'keeper_multiread_batch_size',
    'num_connection_retries',
    'path_acl',
    'sessions_path',
    'last_zxid_seen',
    'chroot',
    'get_priority_load_balancing_hostnames',
    'enable_get_children_optimization',
  ];
  for (const zk of zks) {
    if (ctx.hasSubst(zk)) continue;
    const nodes = childrenNamed(zk, 'node');
    if (!nodes.length && !zk.children.some((c) => c.name === 'include'))
      ctx.add('error', 'zk-nodes', zk, `<${zk.name}> has no <node> endpoints.`, [zref]);
    for (const nd of nodes) {
      if (!child(nd, 'host')) ctx.add('error', 'zk-host', nd, '<node> is missing <host>.', [zref]);
      for (const c of nd.children) {
        if (c.name === 'port') typeCheck(ctx, c, 'Port', { parser: 'poco' }, [zref]);
        else if (c.name === 'secure') typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [zref]);
        else if (!['host', 'availability_zone'].includes(c.name))
          unknownChild(ctx, c, ['host', 'port', 'secure', 'availability_zone'], [zref], { sev: 'info' });
      }
      if (!child(nd, 'port'))
        ctx.add('info', 'zk-port', nd, '<node> has no <port>; the client default (2181) is used.', [zref]);
    }
    for (const c of zk.children) {
      if (c.name === 'node' || c.name === 'include') continue;
      if (!keys.includes(c.name)) {
        unknownChild(ctx, c, keys, [zref], { sev: 'info' });
        continue;
      }
      if (['session_timeout_ms', 'operation_timeout_ms', 'connection_timeout_ms'].includes(c.name))
        typeCheck(ctx, c, 'Int32', { parser: 'poco' }, [zref]);
      if (c.name === 'root' && textOf(c) && !textOf(c).startsWith('/'))
        ctx.add('error', 'zk-root', ctx.valueNode(c), "<root> must start with '/'.", [zref]);
      if (c.name === 'identity' && textOf(c) && !textOf(c).includes(':'))
        ctx.add('warning', 'zk-identity', ctx.valueNode(c), "<identity> should be 'user:password'.", [zref]);
      if (c.name === 'zookeeper_load_balancing' && textOf(c) && !ZK_LB.includes(textOf(c)))
        ctx.add(
          'error',
          'zk-lb',
          ctx.valueNode(c),
          `'${textOf(c)}' is not a valid zookeeper_load_balancing; allowed: ${ZK_LB.join(', ')}.`,
          [zref],
        );
      if (['use_compression', 'use_xid_64', 'pass_opentelemetry_tracing_context', 'secure'].includes(c.name))
        typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [zref]);
    }
  }
}
