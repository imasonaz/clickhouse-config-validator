// Top level of a server config: server settings, misplaced settings, the 26.8+ strict check for unknown
// top-level elements, <merge_tree> and other server-wide sections.

import { child, childrenNamed, textOf, walk, getPath } from '../tree.js';
import { ref, SRC } from '../docs.js';
import { suggest } from '../types.js';
import { cmpVer, tooNew } from '../versions.js';
import { KEEPER_KEYS, SYSTEM_LOGS } from './constants.js';
import { docKeyForPath, isTrue, lifecycle, removedSetting, typeCheck, unknownChild, whereValid } from './helpers.js';

/**
 * ClickHouse 26.8+ refuses to start when a top-level element is neither a server setting nor one of the known
 * sections (ServerSettings::checkUnknownSettings, UNKNOWN_ELEMENT_IN_CONFIG), unless
 * skip_check_for_incorrect_settings is set. Upgrades the findings already made for such keys to errors.
 */
function strictTopLevel(ctx, from) {
  const { schema, cfg, mode } = ctx;
  const st = schema.serverStrict;
  if (
    mode !== 'server' ||
    !st?.since ||
    st.since === 'next' ||
    (ctx.version !== 'latest' && cmpVer(ctx.version, st.since) < 0)
  )
    return;
  if (isTrue(textOf(child(cfg, 'skip_check_for_incorrect_settings')) ?? '')) return;
  const known = new Set([
    ...Object.entries(schema.server)
      .filter(([, d]) => !tooNew(d.since, ctx.version))
      .map(([k]) => k),
    ...Object.values(schema.serverWithPath).map((x) => x.path.split('.')[0]),
    ...st.sections,
    'include',
  ]);
  // Sections referenced by name: HTTP handler groups of <protocols> and config:// payloads of static handlers.
  const groups = [];
  for (const p of child(cfg, 'protocols')?.children || []) {
    const h = textOf(child(p, 'handlers'));
    if (textOf(child(p, 'type')) === 'http' && h) {
      known.add(h.split(/[.[]/)[0]);
      groups.push(h);
    }
  }
  if (child(cfg, 'http_handlers')) groups.push('http_handlers');
  for (const g of groups)
    for (const rule of getPath(cfg, g)?.children || []) {
      const h = child(rule, 'handler');
      if (!h) continue;
      const v = textOf(child(h, 'response_content')) || '';
      if (textOf(child(h, 'type')) === 'static' && v.startsWith('config://')) known.add(v.slice(9).split(/[.[]/)[0]);
    }
  const prefixOk = (k) => st.prefixes.some((p) => k === p || (k.startsWith(p) && k[p.length] === '_'));
  const graphite = (n) =>
    !n.children.length
      ? !(n.text ?? '').trim()
      : n.children.every(
          (c) =>
            c.name.startsWith('pattern') ||
            ['default', 'path_column_name', 'time_column_name', 'value_column_name', 'version_column_name'].includes(
              c.name,
            ),
        );
  const msg = ` Since ${st.since}, ClickHouse refuses to start with an unknown top-level element (UNKNOWN_ELEMENT_IN_CONFIG) unless <skip_check_for_incorrect_settings> is 1.`;
  const sref = ref.source(SRC.serverSettings || SRC.server, 'ServerSettings.cpp (checkUnknownSettings)');
  const seen = new Set();
  for (const n of cfg.children) {
    if (known.has(n.name) || prefixOk(n.name) || graphite(n) || seen.has(n.name)) continue;
    seen.add(n.name);
    const mine = ctx.findings
      .slice(from)
      .filter(
        (f) =>
          f.line === n.line &&
          f.file === n.file &&
          f.path === ctx.relPath(n).join(' › ') &&
          f.code !== 'type' &&
          f.code !== 'empty',
      );
    if (mine.some((f) => f.code === 'session-at-root' && f.sev === 'error')) continue; // that check fails first
    if (mine.length)
      for (const f of mine) {
        f.sev = 'error';
        f.msg =
          f.msg
            .replace(/, so it is ignored\./, '.')
            .replace(
              / (Unknown keys are silently ignored|At the top level ClickHouse ignores it|ClickHouse ignores unknown keys unless a component reads them)\./,
              '',
            ) + msg;
        f.refs = [...f.refs, sref];
      }
    else
      ctx.add('error', 'unknown-element', n, `<${n.name}> is not a server setting or a known config section.${msg}`, [
        sref,
      ]);
  }
}

/** Every top-level element: server settings, known sections, misplaced session/MergeTree/coordination settings. */
export function checkRoot(ctx) {
  const { schema, cfg, add, mode } = ctx;
  const server = schema.server;
  const withPathRoots = new Map();
  for (const s of Object.values(schema.serverWithPath)) withPathRoots.set(s.path.split('.')[0], true);
  const refTop = new Set(schema.refPaths.server.map((p) => p.split('.')[0]));
  const refKeeperTop = new Set(schema.refPaths.keeper.map((p) => p.split('.')[0]));
  const known = new Set([
    ...Object.keys(server),
    ...withPathRoots.keys(),
    ...Object.keys(schema.docPaths),
    ...refTop,
    ...refKeeperTop,
    'users',
    'profiles',
    'quotas',
    'roles',
    'include',
    'keeper_server',
    'include_from',
    ...SYSTEM_LOGS,
    'auxiliary_zookeepers',
    'named_collections',
    'kafka',
    's3',
    'hdfs',
    'azure',
    'dictionaries',
    'functions',
    'encryption_codecs',
    'clickhouse',
    'yandex',
  ]);

  const before = ctx.findings.length;
  for (const n of cfg.children) {
    const name = n.name;
    if (name === 'include') continue;
    const def = server[name];
    if (def) {
      ctx.recognized.push({
        scope: 'server',
        name,
        type: def.t,
        def: def.d,
        value: n.text != null ? n.text.trim() : n.children.length ? '(section)' : '',
        line: n.line,
        file: n.textFile || n.file,
        url: ref.server(name).url,
        desc: def.desc,
      });
      lifecycle(ctx, n, 'server setting', name, def, ref.server(name));
      typeCheck(ctx, n, def.t, {}, [ref.server(name), ref.source(SRC.serverSettings, 'ServerSettings.cpp')]);
      if (
        def.t === 'String' &&
        /trailing slash is mandatory/i.test(def.desc || '') &&
        n.text != null &&
        !ctx.hasSubst(n) &&
        n.text.trim() &&
        !n.text.trim().endsWith('/')
      )
        add(
          'error',
          'trailing-slash',
          ctx.valueNode(n),
          `<${name}> must end with '/': the docs state "The trailing slash is mandatory."`,
          [ref.server(name)],
        );
      if (
        mode === 'keeper' &&
        ![
          'listen_host',
          'max_connections',
          'listen_try',
          'listen_reuse_port',
          'listen_backlog',
          'path',
          'core_dump',
          'timezone',
        ].includes(name) &&
        !refKeeperTop.has(name)
      )
        add(
          'info',
          'server-in-keeper',
          n,
          `<${name}> is a ClickHouse server setting; standalone clickhouse-keeper may ignore it.`,
          [ref.keeper('keeper-configuration-settings')],
        );
      continue;
    }
    if (known.has(name)) continue;
    // Misplaced settings.
    const sess = schema.session[name] || schema.session[schema.sessionAliases[name]];
    if (sess) {
      // Settings::checkNoSettingNamesAtTopLevel: the server refuses to start (UNKNOWN_ELEMENT_IN_CONFIG).
      const fatal =
        mode === 'server' &&
        !sess.obsolete &&
        !['max_table_size_to_drop', 'max_partition_size_to_drop', 'compression'].includes(name) &&
        !isTrue(textOf(child(cfg, 'skip_check_for_incorrect_settings')) ?? '');
      add(
        fatal ? 'error' : 'warning',
        'session-at-root',
        n,
        `<${name}> is a session (query-level) setting${fatal ? `; at the top level of the server config ClickHouse refuses to start ("A setting '${name}' appeared at top level", UNKNOWN_ELEMENT_IN_CONFIG)` : ' and has no effect at the top level'}. Set it in a settings profile, e.g. <profiles><default><${name}>…</${name}></default></profiles>.`,
        [ref.session(name), ref.users('user-nameprofile', 'Settings profiles')],
      );
      continue;
    }
    if (schema.mergeTree[name]) {
      add(
        'warning',
        'mergetree-at-root',
        n,
        `<${name}> is a MergeTree setting. Put it under <merge_tree> to change the server-wide default.`,
        [ref.mergeTree(name), ref.server('merge_tree')],
        { fix: { kind: 'move', to: ['merge_tree'] } },
      );
      continue;
    }
    if (schema.coordination[name]) {
      add(
        'warning',
        'coord-at-root',
        n,
        `<${name}> is a Keeper coordination setting; it belongs in <keeper_server><coordination_settings>.`,
        [ref.keeperCoordination()],
        { fix: { kind: 'move', to: ['keeper_server.coordination_settings'] } },
      );
      continue;
    }
    if (KEEPER_KEYS[name]) {
      add(
        'warning',
        'keeper-at-root',
        n,
        `<${name}> is a Keeper setting; it belongs inside <keeper_server>.`,
        [ref.keeper()],
        { fix: { kind: 'move', to: ['keeper_server'] } },
      );
      continue;
    }
    if (removedSetting(ctx, 'server', n, 'server setting', 'it is ignored', [ref.server(name)])) continue;
    const s = suggest(name, known);
    if (s && s.caseOnly)
      add(
        'error',
        'case',
        n,
        `'${name}' should be '${s.name}': configuration keys are case-sensitive.`,
        [ref.server(s.name)],
        { fix: { kind: 'rename', to: s.name } },
      );
    else if (s)
      add(
        'warning',
        'unknown-key',
        n,
        `Unknown top-level key <${name}>; did you mean <${s.name}>? Unknown keys are silently ignored.`,
        [ref.server(s.name)],
        { fix: { kind: 'rename', to: s.name } },
      );
    else {
      const loc = whereValid(ctx, n);
      if (loc)
        add(
          'warning',
          'unknown-key',
          n,
          `<${name}> is not a top-level server setting.${loc.msg} At the top level ClickHouse ignores it.`,
          loc.refs,
          { fix: { kind: 'move', to: loc.parents } },
        );
      else
        add(
          'info',
          'unknown-key',
          n,
          `<${name}> is not a known server setting (not in ServerSettings.cpp, the server settings docs, or the reference config). ClickHouse ignores unknown keys unless a component reads them.`,
          [ref.server(name)],
        );
    }
  }
  strictTopLevel(ctx, before);

  // Settings configured by path (logger.level, openSSL.server.*, query_cache.*, distributed_ddl.*, …).
  for (const [name, s] of Object.entries(schema.serverWithPath)) {
    const n = getPath(cfg, s.path);
    if (!n) continue;
    ctx.recognized.push({
      scope: 'server',
      name: s.path,
      type: s.t,
      def: s.d,
      value: n.text != null ? n.text.trim() : '',
      line: n.line,
      file: n.textFile || n.file,
      url: ref.server(s.path.split('.')[0]).url,
      desc: s.desc,
    });
    typeCheck(ctx, n, s.t, {}, [
      ref.server(docKeyForPath(ctx.schema, s.path, name)),
      ref.source(SRC.serverSettings, 'ServerSettings.cpp'),
    ]);
  }

  // Known children of path-configured sections (query_cache, distributed_ddl, openSSL.server/client …).
  const sections = new Map();
  for (const s of Object.values(schema.serverWithPath)) {
    const parts = s.path.split('.');
    const parent = parts.slice(0, -1).join('.');
    if (!parent) continue;
    if (!sections.has(parent)) sections.set(parent, new Set());
    sections.get(parent).add(parts[parts.length - 1]);
  }
  for (const p of schema.refPaths.server) {
    const parts = p.split('.');
    const parent = parts.slice(0, -1).join('.');
    if (sections.has(parent)) sections.get(parent).add(parts[parts.length - 1]);
  }
  for (const [parent, kids] of sections) {
    if (parent === 'logger' || parent.startsWith('keeper_server')) continue; // handled in checkLogger / checkKeeper
    const sec = getPath(cfg, parent);
    if (!sec) continue;
    for (const c of sec.children) {
      if (kids.has(c.name) || c.name === 'include') continue;
      if (parent.startsWith('openSSL') && /^(invalidCertificateHandler|privateKeyPassphraseHandler)$/.test(c.name))
        continue;
      unknownChild(ctx, c, [...kids], [ref.server(parent.split('.')[0])], { sev: 'info' });
    }
  }
  const tlsNone = ['openSSL.client.verificationMode']
    .map((p) => getPath(cfg, p))
    .filter((n) => n && textOf(n) === 'none');
  for (const n of tlsNone)
    add(
      'warning',
      'tls-none',
      ctx.valueNode(n),
      'openSSL.client verificationMode is none: certificates of servers this node connects to (replicas, Keeper Raft peers) are not verified.',
      [ref.server('openSSL'), ref.source(SRC.keeperServer, 'KeeperServer.cpp')],
    );
}

/** Smaller server-wide checks: memory ratio, incl/include_from, <merge_tree>, <macros>, timezone. */
export function checkMisc(ctx) {
  const { cfg, add, schema } = ctx;
  const ratio = child(cfg, 'max_server_memory_usage_to_ram_ratio');
  const rv = ratio && textOf(ratio);
  if (rv && /^[\d.]+$/.test(rv)) {
    const f = Number(rv);
    if (f > 1)
      add(
        'info',
        'mem-ratio',
        ctx.valueNode(ratio),
        `max_server_memory_usage_to_ram_ratio = ${f} exceeds 1; only sensible on hosts with low RAM and swap (per the docs).`,
        [ref.server('max_server_memory_usage_to_ram_ratio')],
      );
    if (f === 0)
      add(
        'info',
        'mem-ratio0',
        ctx.valueNode(ratio),
        'A ratio of 0 disables the startup cap and runtime adjustment of the memory limit.',
        [ref.server('max_server_memory_usage_to_ram_ratio')],
      );
  }
  const incl = [];
  walk(cfg, (n) => {
    if (n.attrs.has('incl')) incl.push(n);
  });
  if (incl.length && !child(cfg, 'include_from'))
    add(
      'info',
      'incl-no-include-from',
      incl[0],
      `'incl' substitutions are used but <include_from> is not set in this file. Since 26.8 there is no implicit /etc/metrika.xml; make sure include_from is set (each separately loaded config file needs its own).`,
      [ref.configFiles('substitution-with-file-content', 'Substitution with file content')],
    );
  const envs = [];
  walk(cfg, (n) => {
    if (n.attrs.has('from_env') || n.attrs.has('from_zk')) envs.push(n);
  });
  if (envs.length)
    add(
      'info',
      'subst-unchecked',
      envs[0],
      `${envs.length} element(s) take their value from from_env/from_zk; those values are not validated here.`,
      [ref.configFiles('from_env_zk', 'Substitution by environment variables and ZooKeeper nodes')],
    );

  const lh = childrenNamed(cfg, 'listen_host').map((n) => textOf(n));
  if (lh.includes('::') && lh.includes('0.0.0.0'))
    add(
      'warning',
      'listen-both',
      childrenNamed(cfg, 'listen_host')[1],
      "Both '::' and '0.0.0.0' are listed; on hosts where '::' also binds IPv4 the second listener fails with 'Address already in use'. Use '::' alone (or '0.0.0.0' if IPv6 is disabled).",
      [ref.server('listen_host')],
    );
  const mt = child(cfg, 'merge_tree');
  const rmt = child(cfg, 'replicated_merge_tree');
  for (const sec of [mt, rmt].filter(Boolean)) {
    for (const c of sec.children) {
      if (c.name === 'include') continue;
      const name = schema.mergeTree[c.name] ? c.name : schema.mergeTreeAliases[c.name];
      if (!name) {
        if (
          removedSetting(ctx, 'mergeTree', c, 'MergeTree setting', 'the server refuses to start (UNKNOWN_SETTING)', [
            ref.server(sec.name),
          ])
        )
          continue;
        const s = suggest(c.name, Object.keys(schema.mergeTree));
        const loc = s ? null : whereValid(ctx, c);
        add(
          'error',
          'unknown-mergetree',
          c,
          `Unknown MergeTree setting <${c.name}> in <${sec.name}>${s ? `; did you mean <${s.name}>?` : ''}. The server refuses to start (UNKNOWN_SETTING "in MergeTree config").${loc ? loc.msg : ''}`,
          [
            ref.server(sec.name),
            ref.source(SRC.mergeTree, 'MergeTreeSettings.cpp (loadFromConfig)'),
            ...(loc ? loc.refs : []),
          ],
          { fix: s ? { kind: 'rename', to: s.name } : loc ? { kind: 'move', to: loc.parents } : undefined },
        );
        continue;
      }
      const def = schema.mergeTree[name];
      ctx.recognized.push({
        scope: sec.name,
        name,
        type: def.t,
        def: def.d,
        value: textOf(c) ?? '',
        line: c.line,
        file: c.textFile || c.file,
        url: ref.mergeTree(name).url,
        desc: def.desc,
      });
      lifecycle(ctx, c, 'MergeTree setting', name, def, ref.mergeTree(name), 'mergetree');
      typeCheck(ctx, c, def.t, {}, [ref.mergeTree(name)]);
    }
  }
  const macros = child(cfg, 'macros');
  if (macros && !ctx.hasSubst(macros)) {
    for (const m of macros.children) {
      if (m.children.length)
        add('error', 'macro-nested', m, `Macro <${m.name}> must be a plain value.`, [ref.server('macros')]);
      else if (!textOf(m) && !ctx.hasSubst(m))
        add('warning', 'macro-empty', m, `Macro <${m.name}> is empty.`, [ref.server('macros')]);
    }
  }
  const tz = child(cfg, 'timezone');
  if (tz && textOf(tz) && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$|^UTC$|^Etc\/GMT[+-]\d+$/.test(textOf(tz)))
    add(
      'warning',
      'timezone',
      ctx.valueNode(tz),
      `'${textOf(tz)}' does not look like an IANA time zone name (e.g. Europe/Moscow, UTC).`,
      [ref.server('timezone')],
    );
}
