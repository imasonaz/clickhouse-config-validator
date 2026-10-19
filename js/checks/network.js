// Listening and addresses: duplicate and privileged ports, host values, listen_host coverage.

import { child, childrenNamed, textOf, walk, getPath } from '../tree.js';
import { ref } from '../docs.js';
import { checkHost } from '../net.js';
import { PORT_PATHS } from './constants.js';
import { typeCheck } from './helpers.js';

/** Port values: range, duplicates across listeners (including <protocols>), privileged ports. */
export function checkPorts(ctx) {
  const seen = new Map();
  for (const p of PORT_PATHS) {
    const n = getPath(ctx.cfg, p);
    if (!n || ctx.hasSubst(n)) continue;
    if (!ctx.schema.server[p] && !ctx.schema.serverWithPath[p])
      typeCheck(ctx, n, 'Port', { parser: 'poco' }, [ref.server(p.split('.')[0])]);
    const v = textOf(n);
    if (!v || !/^\d+$/.test(v)) continue;
    if (Number(v) > 65535) {
      if (ctx.schema.server[p])
        ctx.add('error', 'port-range', ctx.valueNode(n), `<${p}> = ${v} is not a valid TCP port (0-65535).`, [
          ref.server(p),
        ]);
      continue;
    }
    if (seen.has(v))
      ctx.add(
        'error',
        'port-dup',
        n,
        `Port ${v} is used by both <${seen.get(v)}> and <${p}>; the second listener fails with "Address already in use".`,
        [ref.server(p.split('.')[0])],
      );
    else seen.set(v, p);
    privileged(ctx, n, v, p);
  }
  // Custom listeners in <protocols>: each entry with a <port> opens its own socket (on <host>, or every listen_host).
  const protos = child(ctx.cfg, 'protocols');
  if (protos && !ctx.hasSubst(protos)) {
    const pref = ref.server('protocols');
    for (const pr of protos.children) {
      const pn = child(pr, 'port');
      const v = pn && textOf(pn);
      if (!v || ctx.hasSubst(pn) || !/^\d+$/.test(v)) continue;
      const host = textOf(child(pr, 'host'));
      const key = host ? `${v}@${host}` : v;
      const label = `protocols.${pr.name}.port`;
      if (seen.has(v) && (!host || !seen.has(key)))
        ctx.add(
          'error',
          'port-dup',
          pn,
          `Port ${v} is used by both <${seen.get(v)}> and <${label}>; the second listener fails with "Address already in use".`,
          [pref],
        );
      else if (seen.has(key))
        ctx.add(
          'error',
          'port-dup',
          pn,
          `Port ${v} is used by both <${seen.get(key)}> and <${label}>; the second listener fails with "Address already in use".`,
          [pref],
        );
      else {
        seen.set(key, label);
        if (!host) seen.set(v, label);
      }
      privileged(ctx, pn, v, label);
    }
  }
}

function privileged(ctx, n, v, label) {
  const port = Number(v);
  if (port > 0 && port < 1024)
    ctx.add(
      'info',
      'port-privileged',
      ctx.valueNode(n),
      `<${label}> = ${port} is a privileged port (below 1024). The server needs CAP_NET_BIND_SERVICE to bind it; the packaged systemd unit grants it, but a container or a manually started server may fail with "Permission denied".`,
      [ref.server(label.split('.')[0])],
    );
}

// Elements whose value is a single host: an IP address, or a DNS name where allowed.
const HOST_KEYS = {
  listen_host: true,
  interserver_listen_host: true,
  interserver_http_host: true,
  host: true,
  hostname: true,
};

/** Host and address values: valid IPv4, IPv6 or host name, with no port attached. */
export function checkHosts(ctx) {
  walk(ctx.cfg, (n) => {
    if (!HOST_KEYS[n.name] || n.children.length || ctx.hasSubst(n)) return;
    const v = textOf(n);
    if (!v || /[{}$]/.test(v)) return; // empty (reported elsewhere) or macro / env placeholder
    const path = ctx.relPath(n);
    if (path.includes('networks')) return; // users networks: host is matched as given; ip is checked separately
    const r = checkHost(v.trim());
    if (r.ok) return;
    const top = path[0] === n.name ? n.name : path[0];
    ctx.add('error', 'bad-address', ctx.valueNode(n), `<${n.name}>: ${r.msg}`, [
      path[0] === 'keeper_server' ? ref.keeper() : ref.server(top),
    ]);
  });
}

const LOOPBACK = (h) => /^(localhost|127(\.\d+){3}|::1|0:0:0:0:0:0:0:1)$/i.test(h);

/** listen_host duplicates, and loopback-only listening when the config names other cluster or Raft hosts. */
export function checkListen(ctx) {
  const { cfg, add } = ctx;
  if (ctx.mode === 'users') return;
  const lref = ref.server('listen_host');
  const lh = childrenNamed(cfg, 'listen_host').filter((n) => !ctx.hasSubst(n) && textOf(n));
  const seen = new Map();
  for (const n of lh) {
    const v = textOf(n).trim();
    if (seen.has(v))
      add(
        'info',
        'listen-dup',
        ctx.valueNode(n),
        `listen_host '${v}' is listed twice (first on line ${seen.get(v).line}). ClickHouse binds it once, so the copy can be removed (verified with 26.9).`,
        [lref],
      );
    else seen.set(v, n);
  }
  if (childrenNamed(cfg, 'listen_host').some((n) => ctx.hasSubst(n))) return;
  // Hosts other nodes would connect from: replicas in remote_servers and Keeper Raft peers.
  const peers = new Set();
  for (const cl of child(cfg, 'remote_servers')?.children || [])
    walk(cl, (n) => {
      if (n.name === 'host' && textOf(n) && !/[{}$]/.test(textOf(n))) peers.add(textOf(n).trim());
    });
  for (const s of getPath(cfg, 'keeper_server.raft_configuration')?.children || []) {
    const h = textOf(child(s, 'hostname'));
    if (h) peers.add(h.trim());
  }
  const remote = [...peers].filter((h) => !LOOPBACK(h));
  if (remote.length < 2) return;
  const what = child(cfg, 'keeper_server') && ctx.mode === 'keeper' ? 'the Keeper client port' : 'this server';
  if (!lh.length)
    add(
      'info',
      'listen-default-local',
      child(cfg, 'remote_servers') || child(cfg, 'keeper_server') || cfg,
      `No <listen_host> is set, so ClickHouse listens on localhost only, but this config lists other hosts (${remote.slice(0, 3).join(', ')}${remote.length > 3 ? '…' : ''}). They can't reach ${what} unless listen_host is set in another config file, e.g. <listen_host>::</listen_host>.`,
      [lref],
    );
  else if (lh.every((n) => LOOPBACK(textOf(n).trim())))
    add(
      'warning',
      'listen-local-only',
      ctx.valueNode(lh[0]),
      `listen_host only covers loopback addresses, but this config lists other hosts (${remote.slice(0, 3).join(', ')}${remote.length > 3 ? '…' : ''}). They can't reach ${what}. Listen on '::' or this host's address.`,
      [lref],
    );
}
