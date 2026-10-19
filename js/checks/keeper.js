// <keeper_server>: Keeper settings, coordination settings, feature flags, four-letter words and raft_configuration
// (rules mirrored from src/Coordination/KeeperStateManager.cpp and KeeperContext.cpp).

import { child, childrenNamed, textOf, getPath } from '../tree.js';
import { ref, SRC } from '../docs.js';
import { suggest, SETTING_BOOL, POCO_BOOL } from '../types.js';
import { cmpVer, tooNew } from '../versions.js';
import { KEEPER_KEYS, RAFT_CONFLICT_PORTS, RAFT_SERVER_KEYS } from './constants.js';
import { isTrue, lifecycle, removedSetting, typeCheck, unknownChild, whereValid } from './helpers.js';

/** Everything under <keeper_server>; `ks` is that node. */
export function checkKeeper(ctx, ks) {
  const { schema, add } = ctx;
  const kref = ref.keeper();
  for (const c of ks.children) {
    if (c.name === 'include') continue;
    const def = KEEPER_KEYS[c.name];
    if (!def) {
      if (schema.coordination[c.name]) {
        add(
          'warning',
          'coord-misplaced',
          c,
          `<${c.name}> is a coordination setting; move it into <keeper_server><coordination_settings>. Here it is ignored.`,
          [ref.keeperCoordination()],
          { fix: { kind: 'move', to: ['keeper_server.coordination_settings'] } },
        );
        continue;
      }
      unknownChild(ctx, c, Object.keys(KEEPER_KEYS), [kref]);
      continue;
    }
    if (def.section) continue;
    ctx.recognized.push({
      scope: 'keeper',
      name: `keeper_server.${c.name}`,
      type: def.t,
      def: '',
      value: textOf(c) ?? '',
      line: c.line,
      file: c.textFile || c.file,
      url: kref.url,
    });
    typeCheck(ctx, c, def.t, { parser: def.p || 'setting' }, [kref]);
  }

  const get = (k) => child(ks, k);
  const required = ['server_id', 'raft_configuration'];
  for (const k of required)
    if (!get(k) && !ks.attrs.has('incl'))
      add('error', 'keeper-required', ks, `<keeper_server> is missing <${k}>.`, [
        kref,
        ref.source(SRC.keeperState, 'KeeperStateManager.cpp'),
      ]);
  if (!get('log_storage_path') && !get('storage_path') && !get('log_storage_disk'))
    add(
      'warning',
      'keeper-log-path',
      ks,
      'No <log_storage_path> (or <storage_path>/<log_storage_disk>); Keeper falls back to a default location under the server path. Set it explicitly, ideally on a dedicated disk.',
      [kref, ref.keeper('using-disks-with-keeper', 'Using disks with Keeper')],
    );
  if (!get('snapshot_storage_path') && !get('storage_path') && !get('snapshot_storage_disk'))
    add(
      'warning',
      'keeper-snap-path',
      ks,
      'No <snapshot_storage_path> (or <storage_path>/<snapshot_storage_disk>); Keeper falls back to a default location.',
      [kref],
    );

  // remove_orphaned_nodes_on_startup requires digest_enabled = false (docs).
  const ron = get('remove_orphaned_nodes_on_startup');
  if (ron && POCO_BOOL.test(textOf(ron) ?? '') && isTrue(textOf(ron))) {
    const de = get('digest_enabled');
    if (!de || isTrue(textOf(de)))
      add('error', 'orphaned-digest', ron, 'remove_orphaned_nodes_on_startup requires digest_enabled to be false.', [
        kref,
      ]);
    add(
      'warning',
      'orphaned-recovery',
      ron,
      'remove_orphaned_nodes_on_startup is a single-node recovery switch; remove it once the node has recovered.',
      [kref],
    );
  }

  // four_letter_word_white_list
  const fl = get('four_letter_word_white_list');
  if (fl && textOf(fl) && textOf(fl) !== '*') {
    for (const w of textOf(fl)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const wref = [ref.keeper4lw(), ref.source(SRC.coordination, 'CoordinationSettings.cpp')];
      const gone = schema.fourLetterWordsRemoved?.[w];
      if (gone) {
        if (ctx.version === 'latest' || cmpVer(ctx.version, gone[1]) > 0)
          add(
            'warning',
            '4lw',
            ctx.valueNode(fl),
            `Four letter word command '${w}' was removed after ${gone[1]}.`,
            wref,
          );
      } else if (!schema.fourLetterWords.includes(w))
        add('warning', '4lw', ctx.valueNode(fl), `Unknown four letter word command '${w}'.`, wref);
      else if (tooNew(schema.fourLetterWordsSince?.[w], ctx.version))
        add(
          'warning',
          'version-too-new',
          ctx.valueNode(fl),
          `Four letter word command '${w}' was added in ${schema.fourLetterWordsSince[w]}; Keeper ${ctx.version} doesn't have it.`,
          wref,
        );
    }
  }
  const sd = get('superdigest');
  if (sd && textOf(sd) && !/^super:.+/.test(textOf(sd)))
    add('error', 'superdigest', ctx.valueNode(sd), "Incorrect superdigest: must be 'super:base64string'.", [
      ref.source(SRC.keeperServer, 'KeeperServer.cpp'),
    ]);
  const pw = ['client_password', 'client_password_sha256_hex', 'client_password_double_sha1_hex'].filter((k) => get(k));
  if (pw.length > 1)
    add('error', 'keeper-auth', get(pw[1]), 'Only one client password type is allowed in the Keeper config.', [
      ref.source(SRC.keeperState, 'KeeperStateManager.cpp'),
    ]);

  // coordination_settings: unknown keys throw UNKNOWN_SETTING at startup.
  const cs = get('coordination_settings');
  if (cs) {
    const names = Object.keys(schema.coordination);
    for (const c of cs.children) {
      if (c.name === 'include') continue;
      const def = schema.coordination[c.name];
      if (!def) {
        if (
          removedSetting(ctx, 'coordination', c, 'coordination setting', 'Keeper refuses to start (UNKNOWN_SETTING)', [
            ref.keeperCoordination(),
          ])
        )
          continue;
        const s = suggest(c.name, names);
        const loc = s ? null : whereValid(ctx, c);
        add(
          'error',
          'unknown-coord',
          c,
          `Unknown coordination setting <${c.name}>${s ? `; did you mean <${s.name}>?` : ''}. Keeper refuses to start (UNKNOWN_SETTING "in Coordination settings config").${loc ? loc.msg : ''}`,
          [
            ref.keeperCoordination(),
            ref.source(SRC.coordination, 'CoordinationSettings.cpp (loadFromConfig)'),
            ...(loc ? loc.refs : []),
          ],
          { fix: s ? { kind: 'rename', to: s.name } : loc ? { kind: 'move', to: loc.parents } : undefined },
        );
        continue;
      }
      ctx.recognized.push({
        scope: 'coordination',
        name: `coordination_settings.${c.name}`,
        type: def.t,
        def: def.d,
        value: textOf(c) ?? '',
        line: c.line,
        file: c.textFile || c.file,
        url: ref.keeperCoordination().url,
        desc: def.desc,
      });
      lifecycle(ctx, c, 'coordination setting', c.name, def, ref.keeperCoordination(), 'coordination');
      typeCheck(ctx, c, def.t, {}, [
        ref.keeperCoordination(),
        ref.source(SRC.coordination, 'CoordinationSettings.cpp'),
      ]);
    }
    const num = (k) => {
      const n = child(cs, k);
      const v = n && textOf(n);
      return v && /^\d+$/.test(v) ? Number(v) : null;
    };
    const lo = num('election_timeout_lower_bound_ms') ?? 1000,
      hi = num('election_timeout_upper_bound_ms') ?? 2000,
      hb = num('heart_beat_interval_ms') ?? 500;
    if (lo > hi)
      add(
        'error',
        'election-bounds',
        child(cs, 'election_timeout_lower_bound_ms') || cs,
        `election_timeout_lower_bound_ms (${lo}) must be <= election_timeout_upper_bound_ms (${hi}).`,
        [ref.keeperCoordination()],
      );
    else if (
      lo === hi &&
      (child(cs, 'election_timeout_lower_bound_ms') || child(cs, 'election_timeout_upper_bound_ms'))
    )
      add(
        'info',
        'election-equal',
        child(cs, 'election_timeout_lower_bound_ms') || cs,
        'Election timeout lower and upper bounds are equal; the docs recommend they differ.',
        [ref.keeperCoordination()],
      );
    if (hb >= lo && (child(cs, 'heart_beat_interval_ms') || child(cs, 'election_timeout_lower_bound_ms')))
      add(
        'warning',
        'heartbeat',
        child(cs, 'heart_beat_interval_ms') || cs,
        `heart_beat_interval_ms (${hb}) is not below election_timeout_lower_bound_ms (${lo}); followers will start elections before heartbeats arrive.`,
        [ref.keeperCoordination()],
      );
    const minS = num('min_session_timeout_ms'),
      maxS = num('session_timeout_ms');
    if (minS != null && maxS != null && minS > maxS)
      add(
        'warning',
        'session-bounds',
        child(cs, 'min_session_timeout_ms'),
        `min_session_timeout_ms (${minS}) is greater than session_timeout_ms (${maxS}).`,
        [ref.keeperCoordination()],
      );
    const sdist = num('snapshot_distance');
    if (sdist != null && sdist < 10000)
      add(
        'warning',
        'snapshot-distance',
        child(cs, 'snapshot_distance'),
        `Very small snapshot_distance (${sdist}); Keeper logs a warning because it degrades performance.`,
        [ref.keeperCoordination(), ref.source(SRC.keeperServer, 'KeeperServer.cpp')],
      );
    const fs = child(cs, 'force_sync');
    if (fs && textOf(fs) && SETTING_BOOL.test(textOf(fs)) && !isTrue(textOf(fs)))
      add(
        'info',
        'force-sync',
        fs,
        'force_sync is disabled: coordination log writes are not fsynced, risking data loss on power failure.',
        [ref.keeperCoordination()],
      );
    const qr = child(cs, 'quorum_reads');
    if (qr && isTrue(textOf(qr)))
      add(
        'info',
        'quorum-reads',
        qr,
        'quorum_reads is enabled; Keeper logs "Quorum reads enabled, Keeper will work slower."',
        [ref.source(SRC.keeperServer, 'KeeperServer.cpp')],
      );
  }

  // feature_flags
  const ff = get('feature_flags');
  if (ff) {
    for (const c of ff.children) {
      const fsince = schema.keeperFeatureFlagsSince?.[c.name.toLowerCase()];
      if (tooNew(fsince, ctx.version))
        add(
          'error',
          'version-too-new',
          c,
          `Keeper feature flag <${c.name}> ${fsince === 'next' ? 'is not in any release yet' : `was added in ${fsince}`}; Keeper ${ctx.version} refuses to start with it.`,
          [ref.keeperFlags()],
        );
      if (!schema.keeperFeatureFlags.includes(c.name.toLowerCase())) {
        const s = suggest(c.name, schema.keeperFeatureFlags);
        add(
          'error',
          'feature-flag',
          c,
          `Invalid Keeper feature flag <${c.name}>${s ? `; did you mean <${s.name}>?` : ''}. Keeper refuses to start.`,
          [ref.keeperFlags(), ref.source(SRC.keeperContext, 'KeeperContext.cpp (initializeFeatureFlags)')],
        );
        continue;
      }
      typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [ref.keeperFlags()]);
    }
  }

  // http_control
  const hc = get('http_control');
  if (hc) {
    for (const c of hc.children) {
      if (!['port', 'secure_port', 'readiness'].includes(c.name))
        unknownChild(ctx, c, ['port', 'secure_port', 'readiness'], [ref.keeperHttp()], { sev: 'info' });
      else if (c.name === 'port' || c.name === 'secure_port')
        typeCheck(ctx, c, 'Port', { parser: 'poco' }, [ref.keeperHttp()]);
    }
  }

  // raft_configuration — mirrors KeeperStateManager::parseServersConfiguration.
  const rc = get('raft_configuration');
  if (rc && !rc.attrs.has('incl') && !rc.attrs.has('from_zk')) {
    const sref = ref.source(SRC.keeperState, 'KeeperStateManager.cpp (parseServersConfiguration)');
    const servers = [];
    for (const c of rc.children) {
      if (c.name === 'secure') {
        typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [kref]);
        continue;
      }
      if (!c.name.startsWith('server')) {
        unknownChild(ctx, c, ['server', 'secure'], [kref], {
          sev: 'warning',
          what: 'raft_configuration element (ignored)',
        });
        continue;
      }
      const entry = { node: c };
      for (const k of ['id', 'hostname', 'port']) {
        const els = childrenNamed(c, k);
        if (els.length > 1)
          add('error', 'raft-multi', els[1], `Multiple <${k}> specified for a single <server>.`, [sref]);
        if (!els.length) add('error', 'raft-missing', c, `<server> is missing required <${k}>.`, [kref, sref]);
      }
      for (const s of c.children) {
        const d = RAFT_SERVER_KEYS[s.name];
        if (!d) {
          unknownChild(ctx, s, Object.keys(RAFT_SERVER_KEYS), [kref]);
          continue;
        }
        typeCheck(ctx, s, d.t, { parser: d.p || 'setting' }, [kref, sref]);
      }
      entry.id = textOf(child(c, 'id'));
      entry.hostname = textOf(child(c, 'hostname'));
      entry.port = textOf(child(c, 'port'));
      entry.learner = child(c, 'can_become_leader') && !isTrue(textOf(child(c, 'can_become_leader')));
      entry.follower = child(c, 'start_as_follower') && isTrue(textOf(child(c, 'start_as_follower')));
      servers.push(entry);
    }
    if (!servers.length) add('error', 'raft-empty', rc, '<raft_configuration> contains no <server> entries.', [kref]);
    const ids = new Map(),
      eps = new Map();
    for (const s of servers) {
      if (s.id != null) {
        if (ids.has(s.id))
          add(
            'error',
            'raft-dup-id',
            s.node,
            `Duplicate raft server id ${s.id} (also used on line ${ids.get(s.id).line}).`,
            [sref],
          );
        else ids.set(s.id, s.node);
      }
      if (s.hostname && s.port) {
        const ep = `${s.hostname}:${s.port}`;
        if (eps.has(ep))
          add(
            'error',
            'raft-dup-endpoint',
            s.node,
            `Duplicate raft endpoint ${ep} (also on line ${eps.get(ep).line}).`,
            [sref],
          );
        else eps.set(ep, s.node);
      }
    }
    const sid = textOf(get('server_id'));
    if (
      sid &&
      servers.length &&
      !ids.has(sid) &&
      !get('server_id').attrs.has('from_env') &&
      !get('server_id').attrs.has('incl')
    )
      add(
        'error',
        'raft-self',
        get('server_id'),
        `server_id ${sid} is not present in <raft_configuration> ("Our server id ${sid} not found in raft_configuration section").`,
        [sref],
      );
    if (servers.length && servers.every((s) => s.follower))
      add(
        'error',
        'raft-followers',
        rc,
        'Every server has <start_as_follower>; at least one must be able to start as leader.',
        [sref],
      );
    const hn = servers.map((s) => s.hostname).filter(Boolean);
    const isLocal = (h) => h === 'localhost' || /^127\./.test(h) || h === '::1';
    const hostChecks = !get('hostname_checks_enabled') || isTrue(textOf(get('hostname_checks_enabled')));
    if (hostChecks && hn.includes('localhost') && hn.some((h) => !isLocal(h)))
      add(
        'error',
        'raft-localhost-mix',
        rc,
        "Mixing 'localhost' and non-local hostnames in raft_configuration is not allowed (different hosts resolve 'localhost' to themselves).",
        [sref],
      );
    else if (hostChecks && hn.filter(isLocal).length > 1 && hn.some((h) => !isLocal(h)))
      add(
        'error',
        'raft-local-multi',
        rc,
        'A local address is specified more than once alongside non-local hostnames; a single host could vote multiple times.',
        [sref],
      );
    if (hn.some((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h) && !isLocal(h)))
      add(
        'info',
        'raft-ip',
        rc,
        'Raft servers are addressed by IP. The docs recommend hostnames if a host can change, since changing an endpoint means removing and re-adding the server.',
        [ref.keeper('internal-coordination-settings', 'Keeper: raft_configuration notes')],
      );
    const voters = servers.filter((s) => !s.learner).length;
    if (voters > 1 && voters % 2 === 0)
      add(
        'warning',
        'raft-even',
        rc,
        `${voters} voting members: an even-sized Raft quorum tolerates no more failures than ${voters - 1} members (majority ${voters / 2 + 1}). Use an odd number of voters.`,
        [ref.keeperQuorum()],
      );
    if (voters === 1 && servers.length === 1)
      add('info', 'raft-single', rc, 'Single-node Keeper: no fault tolerance.', [ref.keeperQuorum()]);
    // Raft port must not collide with a client port of this server.
    const self = servers.find((s) => s.id === sid);
    if (self && self.port) {
      for (const p of RAFT_CONFLICT_PORTS) {
        const n = getPath(ctx.cfg, p);
        if (n && textOf(n) === self.port)
          add(
            'error',
            'raft-port',
            self.node,
            `Raft port ${self.port} of this server equals <${p}>; Keeper refuses to start.`,
            [sref],
          );
      }
    }
  }
}
