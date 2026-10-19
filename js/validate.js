// Validation and linting rules for ClickHouse server and Keeper configuration trees.

import { pathOf, child, childrenNamed, textOf, walk, getPath } from './tree.js';
import { ref, SRC } from './docs.js';
import { checkValue, suggest, SETTING_BOOL, POCO_BOOL } from './types.js';
import { checkHost, isIPv4, isIPv6 } from './net.js';
import { cmpVer, addedIn, obsoleteSince, defaultAt, defaultChanges, removedRange } from './versions.js';

// Attributes ClickHouse's ConfigProcessor understands (configuration-files docs + ConfigProcessor.cpp).
const PREPROCESSOR_ATTRS = new Set(['replace', 'remove', 'incl', 'from_env', 'from_zk', 'optional', 'merge', 'yaml', 'encrypted_by', 'hide_in_preprocessed']);
const SUBST_ATTRS = ['incl', 'from_zk', 'from_env'];
// Attributes that specific sections use.
const CONTEXT_ATTRS = { node: ['index'] };

const SYSTEM_LOGS = ['query_log', 'query_thread_log', 'part_log', 'background_schedule_pool_log', 'trace_log', 'crash_log', 'text_log', 'metric_log',
  'transposed_metric_log', 'bucketed_metric_log', 'error_log', 'filesystem_cache_log', 'filesystem_read_prefetches_log', 's3queue_log', 'azure_queue_log',
  'asynchronous_metric_log', 'opentelemetry_span_log', 'query_views_log', 'zookeeper_log', 'session_log', 'transactions_info_log', 'processors_profile_log',
  'asynchronous_insert_log', 'backup_log', 'blob_storage_log', 'query_metric_log', 'dead_letter_queue', 'zookeeper_connection_log', 'aggregated_zookeeper_log',
  'iceberg_metadata_log', 'delta_lake_metadata_log', 'predicate_statistics_log'];
const SYSTEM_LOG_KEYS = ['database', 'table', 'engine', 'partition_by', 'order_by', 'ttl', 'storage_policy', 'settings', 'flush_interval_milliseconds',
  'max_size_rows', 'reserved_size_rows', 'buffer_size_rows_flush_threshold', 'flush_on_crash', 'collect_interval_milliseconds', 'symbolize', 'schema_type',
  'enable_user_query_log', 'level', 'cluster'];
const SYSTEM_LOG_TYPES = { flush_interval_milliseconds: 'UInt64', max_size_rows: 'UInt64', reserved_size_rows: 'UInt64', buffer_size_rows_flush_threshold: 'UInt64',
  collect_interval_milliseconds: 'UInt64' };

const LOGGER_LEVELS = ['none', 'fatal', 'critical', 'error', 'warning', 'notice', 'information', 'debug', 'trace', 'test'];

// keeper_server keys (Keeper docs table + keys read in src/Coordination/*). parser: how the value is read.
const KEEPER_KEYS = {
  tcp_port: { t: 'Port', p: 'poco' }, tcp_port_secure: { t: 'Port', p: 'poco' }, server_id: { t: 'Int32', p: 'poco' },
  log_storage_path: { t: 'String' }, snapshot_storage_path: { t: 'String' }, storage_path: { t: 'String' }, data_storage_path: { t: 'String' },
  log_storage_disk: { t: 'String' }, latest_log_storage_disk: { t: 'String' }, snapshot_storage_disk: { t: 'String' },
  latest_snapshot_storage_disk: { t: 'String' }, old_log_storage_disk: { t: 'String' }, old_snapshot_storage_disk: { t: 'String' }, state_storage_disk: { t: 'String' },
  enable_reconfiguration: { t: 'Bool', p: 'poco' }, max_memory_usage_soft_limit: { t: 'UInt64', p: 'poco' },
  max_memory_usage_soft_limit_ratio: { t: 'Double' }, cgroups_memory_observer_wait_time: { t: 'UInt64', p: 'poco' },
  digest_enabled: { t: 'Bool', p: 'poco' }, digest_enabled_on_commit: { t: 'Bool', p: 'poco' }, create_snapshot_on_exit: { t: 'Bool', p: 'poco' },
  upload_snapshot_on_exit: { t: 'Bool', p: 'poco' }, remove_orphaned_nodes_on_startup: { t: 'Bool', p: 'poco' },
  hostname_checks_enabled: { t: 'Bool', p: 'poco' }, four_letter_word_white_list: { t: 'String' }, enable_ipv6: { t: 'Bool', p: 'poco' },
  superdigest: { t: 'String' }, force_recovery: { t: 'Bool', p: 'poco' }, client_password: { t: 'String' }, client_password_sha256_hex: { t: 'String' },
  client_password_double_sha1_hex: { t: 'String' }, cleanup_old_and_ignore_new_acl: { t: 'Bool', p: 'poco' },
  socket_receive_timeout_sec: { t: 'UInt64' }, socket_send_timeout_sec: { t: 'UInt64' },
  coordination_settings: { section: true }, raft_configuration: { section: true }, feature_flags: { section: true }, http_control: { section: true },
  precommit_sleep_ms_for_testing: { t: 'UInt64', p: 'poco' }, precommit_sleep_probability_for_testing: { t: 'Double' },
};
const RAFT_SERVER_KEYS = { id: { t: 'Int32', p: 'poco' }, hostname: { t: 'String' }, port: { t: 'Port', p: 'poco' },
  can_become_leader: { t: 'Bool', p: 'poco' }, priority: { t: 'Int32', p: 'poco' }, start_as_follower: { t: 'Bool', p: 'poco' } };

// Root-level port keys a listener binds to; used for duplicate-port and raft-port checks
// (list taken from getClientPorts() in src/Coordination/KeeperStateManager.cpp plus other listeners).
const PORT_PATHS = ['tcp_port', 'tcp_port_secure', 'http_port', 'https_port', 'interserver_http_port', 'interserver_https_port', 'mysql_port',
  'postgresql_port', 'grpc_port', 'tcp_with_proxy_port', 'tcp_ssh_port', 'arrowflight_port', 'prometheus.port', 'keeper_server.tcp_port',
  'keeper_server.tcp_port_secure', 'keeper_server.http_control.port'];
const RAFT_CONFLICT_PORTS = ['keeper_server.tcp_port', 'keeper_server.tcp_port_secure', 'interserver_http_port', 'interserver_https_port', 'tcp_port',
  'tcp_with_proxy_port', 'tcp_port_secure', 'mysql_port', 'postgresql_port', 'grpc_port', 'prometheus.port'];

const USER_AUTH_KEYS = ['password', 'password_sha256_hex', 'password_scram_sha256_hex', 'password_double_sha1_hex', 'no_password', 'ldap', 'kerberos',
  'ssl_certificates', 'ssh_keys', 'http_authentication'];
const USER_KEYS = [...USER_AUTH_KEYS, 'auth_methods', 'networks', 'profile', 'quota', 'access_management', 'named_collection_control', 'named_collection_admin',
  'show_named_collections', 'show_named_collections_secrets', 'grants', 'allow_databases', 'allow_dictionaries', 'databases', 'default_database',
  'time_based_one_time_password', 'settings', 'roles', 'default_roles', 'valid_until', 'access_storage', 'host', 'ssh_key'];
const DISK_TYPES = ['local', 's3', 's3_plain', 's3_plain_rewritable', 'azure_blob_storage', 'azure', 'hdfs', 'web', 'cache', 'encrypted', 'object_storage',
  'local_blob_storage', 'memory'];
const ZK_LB = ['random', 'in_order', 'nearest_hostname', 'hostname_levenshtein_distance', 'first_or_random', 'round_robin'];

// Server-only keys used to tell a full server config from a standalone Keeper config.
const SERVER_ONLY_HINTS = ['path', 'tmp_path', 'http_port', 'tcp_port', 'users', 'profiles', 'remote_servers', 'mark_cache_size', 'users_config',
  'user_directories', 'merge_tree', 'query_log', 'macros', 'zookeeper', 'storage_configuration', 'default_profile', 'interserver_http_port'];

export { KEEPER_KEYS, USER_KEYS, SYSTEM_LOGS, locationIndex };

export function detectMode(root) {
  const names = new Set(root.children.map((c) => c.name));
  const hasKeeper = names.has('keeper_server');
  const serverHints = SERVER_ONLY_HINTS.filter((k) => names.has(k)).length;
  if (hasKeeper && serverHints === 0) return 'keeper';
  if (!hasKeeper && (names.has('profiles') || names.has('users') || names.has('quotas')) && serverHints <= 3 &&
      [...names].every((n) => ['profiles', 'users', 'quotas', 'roles', 'include_from', 'settings_profiles', 'custom_settings_prefixes'].includes(n))) return 'users';
  return 'server';
}

export function validate(doc, { schema, mode = 'auto', format = 'xml', version = 'latest', featureTier = null } = {}) {
  const findings = [];
  const recognized = [];   // settings we recognised (for the overview table)
  const root = doc.root;
  const effectiveMode = mode === 'auto' ? detectMode(root) : mode;

  // When a YAML file has an explicit `clickhouse:` key we validate its contents as the root.
  const cfg = (format !== 'xml' && doc.meta && doc.meta.explicitClickhouseRoot) ? doc.meta.explicitClickhouseRoot : root;
  const relPath = (n) => { const p = pathOf(n); return cfg === root ? p : p.slice(1); };
  const add = (sev, code, node, msg, refs = [], extra = {}) => {
    findings.push({
      sev, code, refs,
      msg: msg.replace(/\?\./g, '?'),
      line: extra.line ?? node?.line ?? 1,
      col: extra.col ?? node?.col ?? 1,
      path: node ? relPath(node).join(' › ') : '',
      file: extra.file ?? node?.file,
      ...(extra.fix ? { fix: { from: node?.name, ...extra.fix } } : {}),
    });
  };
  const hasSubst = (n) => SUBST_ATTRS.some((a) => n.attrs.has(a)) || n.attrs.has('encrypted_by');
  const valueNode = (n) => ({ ...n, line: n.textLine || n.line, col: 1, file: n.textFile || n.file });

  // ---------------------------------------------------------------- parse-level notes
  for (const w of doc.warnings || []) add('warning', 'syntax', null, w.message, [], { line: w.line, col: w.col });

  if (format === 'xml') {
    if (root.name === 'yandex') {
      add('warning', 'root-yandex', root, 'Root element <yandex> is the legacy name; use <clickhouse>.', [ref.configFiles(null, 'Configuration files: top-level tag')]);
    } else if (root.name !== 'clickhouse') {
      add('error', 'root-name', root, `Root element is <${root.name}>; configuration files must use <clickhouse> as the top-level tag. Files in config.d/ with a different root fail to merge ("Root element doesn't have the corresponding root element as the config file").`,
        [ref.configFiles(null, 'Configuration files: top-level tag'), ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (mergeRecursive)')]);
    }
  } else if (doc.meta) {
    const m = doc.meta;
    if (m.explicitClickhouseRoot) {
      add('error', 'yaml-explicit-root', m.explicitClickhouseRoot,
        `Top-level "${m.explicitClickhouseRoot.name}:" key. YAMLParser always wraps the document in a <clickhouse> element, so this key produces <clickhouse><${m.explicitClickhouseRoot.name}>… and every setting below it is ignored (verified with ClickHouse 26.9: http_port under it is not read). Remove the key and de-indent its contents. The rest of this report validates the contents as if the key were absent.`,
        [ref.source(SRC.yamlParser, 'YAMLParser.cpp (buildXMLFromYAMLNode)'), ref.configFiles(null, 'Configuration files'), ref.configFiles('implementation-details', 'Preprocessed files')]);
    }
    for (const d of m.duplicateKeys) add('warning', 'yaml-dup-key', null, `Duplicate key '${d.key}' (first defined on line ${d.first}). Both copies become separate elements; ClickHouse reads only the first for a scalar setting. Use a YAML sequence if repetition is intended.`, [ref.configFiles('example-1', 'YAML examples')], { line: d.line, col: d.col });
    for (const mk of m.mergeKeys) add('warning', 'yaml-merge-key', null, "YAML merge key '<<' is not converted by ClickHouse's YAMLParser; it becomes an element literally named '<<'. Repeat the keys instead.", [ref.source(SRC.yamlParser, 'YAMLParser.cpp')], mk);
    for (const nk of m.nonStringKeys) add('error', 'yaml-complex-key', null, 'Complex (non-scalar) YAML keys cannot be represented as XML element names.', [ref.source(SRC.yamlParser, 'YAMLParser.cpp')], nk);
  }


  // ---------------------------------------------------------------- generic per-node checks
  walk(cfg, (n) => {
    if (n === cfg) return;
    const ctxAttrs = CONTEXT_ATTRS[n.name] || [];
    for (const [a, info] of n.attrs) {
      if (!PREPROCESSOR_ATTRS.has(a) && !ctxAttrs.includes(a)) {
        const s = suggest(a, [...PREPROCESSOR_ATTRS]);
        add(s ? 'warning' : 'info', 'unknown-attr', n, `Attribute '${a}' is not a ClickHouse preprocessing attribute${s ? `; did you mean '${s.name}'?` : ' and is usually ignored.'}`,
          [ref.configFiles('merging', 'Merging configuration'), ref.configFiles('from_env_zk', 'Substitutions')], { line: info.line, col: info.col });
      }
    }
    const substs = SUBST_ATTRS.filter((a) => n.attrs.has(a));
    if (substs.length > 1) add('error', 'multi-subst', n, `More than one substitution attribute (${substs.join(', ')}) on <${n.name}>; only one is allowed.`, [ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (doIncludesRecursive)')]);
    for (const a of ['from_env', 'from_zk']) {
      if (n.attrs.has(a) && !n.attrs.has('replace') && (n.children.length || (n.text && n.text.trim())))
        add('error', 'subst-has-value', n, `<${n.name}> has a value and '${a}' but no 'replace' attribute; ClickHouse fails with "has value and does not have 'replace' attribute, can't process ${a} substitution". Add replace="1" to use the value as a default.`, [ref.configFiles('default-values', 'Substitution default values'), ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (doIncludesRecursive)')]);
    }
    if (n.attrs.has('yaml')) {
      if (n.name !== 'include' || !n.attrs.has('from_zk')) add('error', 'yaml-attr', n, "Attribute 'yaml' is allowed only on <include from_zk=...>.", [ref.source(SRC.configProcessor, 'ConfigProcessor.cpp')]);
      else if (n.attrs.get('yaml').value !== 'true') add('error', 'yaml-attr', n, "Attribute 'yaml' for <include from_zk=...> must be 'true'.", [ref.source(SRC.configProcessor, 'ConfigProcessor.cpp')]);
    }
    if (n.name === 'include') {
      if (n.children.length || (n.text && n.text.trim())) add('error', 'include-children', n, '<include> element must have no children.', [ref.source(SRC.configProcessor, 'ConfigProcessor.cpp')]);
      if (!substs.length) add('error', 'include-no-subst', n, '<include> has no substitution attribute (incl, from_zk or from_env); exactly one is required.', [ref.configFiles('substitution-with-file-content', 'Substitution with file content'), ref.source(SRC.configProcessor, 'ConfigProcessor.cpp')]);
    }
    if (n.attrs.has('replace') && n.attrs.has('remove')) add('error', 'replace-remove', n, `<${n.name}> has both 'replace' and 'remove'; ClickHouse throws "both remove and replace attributes set for element" while merging.`, [ref.configFiles('merging', 'Merging configuration'), ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (mergeRecursive)')]);
    if (n.attrs.has('replace') && substs.length && n.attrs.get('replace').line > n.attrs.get(substs[0]).line && format === 'xml')
      add('info', 'replace-order', n, `For a default value with ${substs[0]}, the docs say 'replace' must appear before '${substs[0]}'.`, [ref.configFiles('default-values', 'Substitution default values')]);
    if (n.mixedText) add('warning', 'mixed-content', n, `<${n.name}> mixes text ('${n.mixedText.text.slice(0, 40)}') with child elements; the text is ignored.`, [], { line: n.mixedText.line });
    if (n.name.includes('.')) add('warning', 'dotted-name', n, `Element name '${n.name}' contains '.', which Poco uses as the path separator; ClickHouse cannot address it as one key.`, [ref.source(SRC.cluster, 'Cluster.cpp (dots not supported in cluster names)')]);
    if (format !== 'xml' && !/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(n.name) && n.name !== '<<') add('warning', 'bad-name', n, `'${n.name}' is not a valid XML element name; ClickHouse converts YAML keys to XML elements.`, [ref.configFiles('example-1', 'YAML examples')]);
  });

  // Duplicate sibling elements where ClickHouse reads a single value.
  walk(cfg, (n) => {
    const counts = new Map();
    for (const c of n.children) {
      if (c.yamlSeqClone) continue;
      const k = c.name;
      if (!counts.has(k)) counts.set(k, []);
      counts.get(k).push(c);
    }
    for (const [k, arr] of counts) {
      if (arr.length < 2) continue;
      const allLeaf = arr.every((c) => !c.children.length);
      if (!allLeaf || isRepeatable(relPath(arr[0]))) continue;
      add('warning', 'duplicate-element', arr[1], `<${k}> appears ${arr.length} times under <${n.name}>. ClickHouse reads only the first (line ${arr[0].line}); later copies are reachable only as ${k}[1], ${k}[2]… by code that iterates over them.`,
        [ref.configFiles('merging', 'Merging configuration')]);
    }
  });

  // allow_feature_tier: from this document, or passed in (e.g. from the server config when checking users.xml).
  const aft = getPath(cfg, 'allow_feature_tier');
  const tierLimit = aft && /^\d+$/.test(textOf(aft) || '') ? Number(textOf(aft)) : featureTier;
  const ctx = { schema, add, recognized, mode: effectiveMode, cfg, relPath, hasSubst, valueNode, format, root, version, tierLimit };

  // ---------------------------------------------------------------- section checks
  checkRoot(ctx);
  const ks = child(cfg, 'keeper_server');
  if (ks) checkKeeper(ctx, ks);
  else if (effectiveMode === 'keeper') add('error', 'keeper-missing', cfg, 'No <keeper_server> section: a Keeper configuration needs one.', [ref.keeper()]);
  if (ks && effectiveMode === 'server') add('info', 'embedded-keeper', ks, 'This server config contains <keeper_server>, so ClickHouse runs an embedded Keeper. Validated with the Keeper rules.', [ref.keeper('configuration', 'Keeper configuration')]);
  checkPorts(ctx);
  checkUsersFile(ctx);
  checkRemoteServers(ctx);
  checkZookeeper(ctx);
  checkSystemLogs(ctx);
  checkStorage(ctx);
  checkLogger(ctx);
  checkMisc(ctx);
  checkHosts(ctx);
  checkEncryptionCodecs(ctx);

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.sev] - order[b.sev] || a.line - b.line);
  return { findings, mode: effectiveMode, recognized };
}

// Elements that are legitimately repeated.
function isRepeatable(p) {
  const s = p.join('.');
  const last = p[p.length - 1];
  return /^(listen_host|interserver_listen_host)$/.test(s) ||
    ['node', 'shard', 'replica', 'server', 'ip', 'host', 'host_regexp', 'disk', 'rule', 'case', 'include', 'interval', 'grants', 'query', 'pattern',
      'retention', 'regexp', 'prefix', 'level', 'logger', 'ssh_key', 'common_name', 'subject_alt_name', 'database', 'dictionary', 'key',
      'access_key_id', 'header', 'url', 'path', 'role', 'name'].includes(last) ||
    s.startsWith('remote_url_allow_hosts') || s.startsWith('custom_settings_prefixes') || s.startsWith('url_scheme_mappers') ||
    s.startsWith('kafka') || s.startsWith('named_collections') || s.startsWith('http_handlers') || s.startsWith('proxy') || s.startsWith('dictionaries_config') ||
    s.startsWith('user_defined_executable_functions_config') || s.startsWith('graphite_rollup');
}

// ------------------------------------------------------------------ helpers
function typeCheck(ctx, node, type, opts, refs) {
  if (ctx.hasSubst(node)) return;
  if (node.children.length) {
    if (type !== 'String') ctx.add('error', 'nesting', node, `<${node.name}> expects a ${type} value but contains child elements (${node.children.slice(0, 3).map((c) => `<${c.name}>`).join(', ')}${node.children.length > 3 ? ', …' : ''}).`, refs);
    return;
  }
  const raw = node.text ?? '';
  if (raw.trim() === '' && type !== 'String') {
    ctx.add('error', 'empty', ctx.valueNode(node), `<${node.name}> is empty; expected ${type}.`, refs);
    return;
  }
  if ((opts?.parser ?? 'setting') === 'setting' && raw !== raw.trim() && type !== 'String' && raw.trim()) {
    ctx.add('warning', 'whitespace', ctx.valueNode(node), `Value of <${node.name}> has surrounding whitespace. ClickHouse setting parsers do not trim, so '${raw.replace(/\n/g, '\\n')}' may fail to parse; keep the value on one line with the tags.`,
      [...refs, ref.source(SRC.settingsParse, 'SettingsFieldsConversionHelpers.cpp')]);
  }
  const r = checkValue(type, raw, { parser: opts?.parser, enums: ctx.schema.enums });
  if (r) ctx.add(r.sev, 'type', ctx.valueNode(node), `<${node.name}>: ${r.msg}`, [...refs, ...r.refs]);
}

function unknownChild(ctx, node, known, refs, { sev = 'warning', what = 'key' } = {}) {
  const s = suggest(node.name, known);
  if (s && s.caseOnly) {
    ctx.add('error', 'case', node, `'${node.name}' should be '${s.name}': ClickHouse configuration keys are case-sensitive.`, refs, { fix: { kind: 'rename', to: s.name } });
    return;
  }
  const loc = s ? null : whereValid(ctx, node);
  ctx.add(s || loc ? 'warning' : sev, 'unknown-key', node, `Unknown ${what} <${node.name}>${s ? `; did you mean <${s.name}>?` : '.'}${loc ? loc.msg : ''}`,
    [...refs, ...(loc ? loc.refs : [])], { fix: s ? { kind: 'rename', to: s.name } : loc ? { kind: 'move', to: loc.parents } : undefined });
}

// Collapse user-chosen names (cluster, disk, user...) so paths compare by structure.
const normLoc = (p) => p
  .replace(/^remote_servers\.[^.]+/, 'remote_servers.<cluster>')
  .replace(/^storage_configuration\.disks\.[^.]+/, 'storage_configuration.disks.<disk>')
  .replace(/^storage_configuration\.policies\.[^.]+/, 'storage_configuration.policies.<policy>')
  .replace(/^users\.[^.]+/, 'users.<user>').replace(/^profiles\.[^.]+/, 'profiles.<profile>');

// Index of where each key name is valid: element name -> Map(parent path -> { label, ref }).
const LOC_CACHE = new WeakMap();
function locationIndex(schema) {
  if (LOC_CACHE.has(schema)) return LOC_CACHE.get(schema);
  const idx = new Map();
  const put = (name, parent, label, r) => {
    if (!idx.has(name)) idx.set(name, new Map());
    const m = idx.get(name);
    if (!m.has(parent)) m.set(parent, { label, ref: r });
  };
  for (const name of Object.keys(schema.server)) put(name, '', 'server setting', () => ref.server(name));
  for (const s of Object.values(schema.serverWithPath)) { const segs = s.path.split('.'); put(segs.pop(), segs.join('.'), 'server setting', () => ref.server(segs[0] || s.path)); }
  for (const name of Object.keys(KEEPER_KEYS)) put(name, 'keeper_server', 'Keeper setting', () => ref.keeper());
  for (const name of Object.keys(schema.coordination)) put(name, 'keeper_server.coordination_settings', 'Keeper coordination setting', () => ref.keeperCoordination());
  for (const name of Object.keys(schema.mergeTree)) { put(name, 'merge_tree', 'MergeTree setting', () => ref.mergeTree(name)); put(name, 'replicated_merge_tree', 'MergeTree setting', () => ref.mergeTree(name)); }
  for (const name of Object.keys(schema.session)) put(name, 'profiles.<profile>', 'session setting', () => ref.session(name));
  for (const name of USER_KEYS) put(name, 'users.<user>', 'user property', () => ref.users());
  for (const [list, label] of [[schema.refPaths.server, 'server key'], [schema.refPaths.keeper, 'Keeper key']]) for (const p of list) {
    const segs = p.split('.');
    const name = segs.pop();
    const parent = normLoc(segs.join('.'));
    put(name, parent, label, () => (parent.startsWith('keeper_server') ? ref.keeper() : ref.server(segs[0] || name)));
  }
  LOC_CACHE.set(schema, idx);
  return idx;
}

/** For an unknown key, name the places where a key of that name is valid (when there are few enough to be useful). */
function whereValid(ctx, node) {
  const m = locationIndex(ctx.schema).get(node.name);
  if (!m) return null;
  const here = normLoc(ctx.relPath(node).slice(0, -1).join('.'));
  const cands = [...m].filter(([p]) => p !== here);
  if (!cands.length || cands.length > 4) return null;
  const show = (p) => (p ? p.split('.').map((x) => (x.startsWith('<') ? x.replace(/^<(\w+)>$/, '<$1 name>') : `<${x}>`)).join(' › ') : 'the top level, directly under <clickhouse>');
  const msg = cands.length === 1
    ? ` It belongs at ${show(cands[0][0])} (${cands[0][1].label}); move it there.`
    : ` A key named <${node.name}> is valid at: ${cands.map(([p, v]) => `${show(p)} (${v.label})`).join('; ')}.`;
  const refs = [];
  for (const [, v] of cands) { const r = v.ref(); if (!refs.some((x) => x.url === r.url)) refs.push(r); }
  return { msg, refs: refs.slice(0, 2), parents: cands.map(([p]) => p) };
}

const TIER = {
  experimental: { sev: 'warning', rank: 1, text: 'experimental: in active development and not for production use' },
  private_preview: { sev: 'warning', rank: 2, text: 'in private preview: on the path to general availability but not recommended for production yet' },
  beta: { sev: 'info', rank: 3, text: 'beta: no known bugs, but correctness together with other features is not guaranteed' },
};
const TIER_NAME = { experimental: 'experimental', private_preview: 'private preview', beta: 'beta' };

/** Obsolete, feature tier and version-availability notes for a recognised setting; also fixes up the
 *  overview row's default for the target version. kind: 'profile' | 'mergetree' marks settings whose
 *  unknown names stop the server from loading the config. */
function lifecycle(ctx, node, what, name, def, docRef, kind = '') {
  const refs = [docRef];
  const row = ctx.recognized[ctx.recognized.length - 1];
  if (row && row.name.endsWith(name)) {
    row.def = defaultAt(def, ctx.version);
    const ch = defaultChanges(def);
    if (ch.length) row.hist = ch.map((c) => `${c.version}: ${c.from} → ${c.to}`).join('; ');
    if (def.tier) row.tier = def.tier;
  }
  const o = def.obsolete ? obsoleteSince(def) : null;
  if (def.obsolete && (ctx.version === 'latest' || !o || cmpVer(o.version, ctx.version) <= 0)) {
    ctx.add('warning', 'obsolete', node, `<${node.name}> is an obsolete ${what}${o ? ` (since ${o.version})` : ''} and has no effect; remove it.${o && !/^obsolete setting\.?$/i.test(o.reason) ? ` Reason: ${o.reason}` : ''}`, refs);
    return;
  }
  const added = addedIn(def);
  if (ctx.version !== 'latest' && added && (added === 'next' || cmpVer(added, ctx.version) > 0)) {
    const fail = kind === 'profile' ? 'loading the users config fails with UNKNOWN_SETTING' : kind === 'mergetree' || kind === 'coordination' ? `${kind === 'coordination' ? 'Keeper' : 'the server'} refuses to start (UNKNOWN_SETTING)` : 'it is ignored';
    const when = added === 'next' ? 'is not in any release yet (only in the master sources)' : `was added in ${added}`;
    ctx.add('error', 'version-too-new', node, `<${node.name}> ${when}; on ${ctx.version} it doesn't exist, so ${fail}.`, refs);
  }
  if (def.tier && !def.obsolete) {
    const t = TIER[def.tier];
    ctx.add(t.sev, `tier-${def.tier.replace('_', '-')}`, node, `<${node.name}> is ${t.text}.`, [...refs, ref.server('allow_feature_tier')]);
    if ((kind === 'profile' || kind === 'mergetree') && ctx.tierLimit != null && ctx.tierLimit >= t.rank)
      ctx.add('warning', 'tier-blocked', node, `allow_feature_tier is ${ctx.tierLimit}, which rejects changes to ${TIER_NAME[def.tier]} settings like <${node.name}> (it acts like a readonly constraint on them).`, [ref.server('allow_feature_tier')]);
  }
}

/** For a name that isn't declared any more: whether the target version still has it, and the message to use.
 *  Returns false when the setting never existed in an indexed release. */
function removedSetting(ctx, scope, node, what, consequence, refs) {
  const r = removedRange(ctx.schema, scope, node.name);
  if (!r) return false;
  const [first, last] = r;
  const span = first ? `${first} to ${last}` : `up to ${last}`;
  if (ctx.version !== 'latest' && cmpVer(ctx.version, last) <= 0 && (!first || cmpVer(ctx.version, first) >= 0)) {
    ctx.add('info', 'removed-later', node, `<${node.name}> is a ${what} in ${ctx.version} but was removed after ${last} (present in releases ${span}). Remove it before upgrading: ${consequence}.`, refs);
  } else {
    ctx.add(consequence.startsWith('it is ignored') ? 'warning' : 'error', 'removed-setting', node, `<${node.name}> was a ${what} in releases ${span} and has been removed, so ${consequence}.`, refs);
  }
  return true;
}

function settingDoc(scope, name) {
  return scope === 'session' ? ref.session(name) : scope === 'mergeTree' ? ref.mergeTree(name) : scope === 'coordination' ? ref.keeperCoordination() : ref.server(name);
}

// ------------------------------------------------------------------ root level
function checkRoot(ctx) {
  const { schema, cfg, add, mode } = ctx;
  const server = schema.server;
  const withPathRoots = new Map();
  for (const [name, s] of Object.entries(schema.serverWithPath)) withPathRoots.set(s.path.split('.')[0], true);
  const refTop = new Set(schema.refPaths.server.map((p) => p.split('.')[0]));
  const refKeeperTop = new Set(schema.refPaths.keeper.map((p) => p.split('.')[0]));
  const known = new Set([...Object.keys(server), ...withPathRoots.keys(), ...Object.keys(schema.docPaths), ...refTop, ...refKeeperTop,
    'users', 'profiles', 'quotas', 'roles', 'include', 'keeper_server', 'include_from', ...SYSTEM_LOGS, 'auxiliary_zookeepers', 'named_collections',
    'kafka', 's3', 'hdfs', 'azure', 'dictionaries', 'functions', 'encryption_codecs', 'clickhouse', 'yandex']);

  for (const n of cfg.children) {
    const name = n.name;
    if (name === 'include') continue;
    const def = server[name];
    if (def) {
      ctx.recognized.push({ scope: 'server', name, type: def.t, def: def.d, value: n.text != null ? n.text.trim() : (n.children.length ? '(section)' : ''), line: n.line, file: n.textFile || n.file, url: ref.server(name).url, desc: def.desc });
      lifecycle(ctx, n, 'server setting', name, def, ref.server(name));
      typeCheck(ctx, n, def.t, {}, [ref.server(name), ref.source(SRC.serverSettings, 'ServerSettings.cpp')]);
      if (def.t === 'String' && /trailing slash is mandatory/i.test(def.desc || '') && n.text != null && !ctx.hasSubst(n) && n.text.trim() && !n.text.trim().endsWith('/'))
        add('error', 'trailing-slash', ctx.valueNode(n), `<${name}> must end with '/': the docs state "The trailing slash is mandatory."`, [ref.server(name)]);
      if (mode === 'keeper' && !['listen_host', 'max_connections', 'listen_try', 'listen_reuse_port', 'listen_backlog', 'path', 'core_dump', 'timezone'].includes(name) && !refKeeperTop.has(name))
        add('info', 'server-in-keeper', n, `<${name}> is a ClickHouse server setting; standalone clickhouse-keeper may ignore it.`, [ref.keeper('keeper-configuration-settings')]);
      continue;
    }
    if (known.has(name)) continue;
    // Misplaced settings.
    const sess = schema.session[name] || schema.session[schema.sessionAliases[name]];
    if (sess) {
      add('warning', 'session-at-root', n, `<${name}> is a session (query-level) setting. At the top level of the server config it has no effect; set it in a settings profile, e.g. <profiles><default><${name}>…</${name}></default></profiles>.`,
        [ref.session(name), ref.users('user-nameprofile', 'Settings profiles')]);
      continue;
    }
    if (schema.mergeTree[name]) {
      add('warning', 'mergetree-at-root', n, `<${name}> is a MergeTree setting. Put it under <merge_tree> to change the server-wide default.`, [ref.mergeTree(name), ref.server('merge_tree')], { fix: { kind: 'move', to: ['merge_tree'] } });
      continue;
    }
    if (schema.coordination[name]) {
      add('warning', 'coord-at-root', n, `<${name}> is a Keeper coordination setting; it belongs in <keeper_server><coordination_settings>.`, [ref.keeperCoordination()], { fix: { kind: 'move', to: ['keeper_server.coordination_settings'] } });
      continue;
    }
    if (KEEPER_KEYS[name]) {
      add('warning', 'keeper-at-root', n, `<${name}> is a Keeper setting; it belongs inside <keeper_server>.`, [ref.keeper()], { fix: { kind: 'move', to: ['keeper_server'] } });
      continue;
    }
    if (removedSetting(ctx, 'server', n, 'server setting', 'it is ignored', [ref.server(name)])) continue;
    const s = suggest(name, known);
    if (s && s.caseOnly) add('error', 'case', n, `'${name}' should be '${s.name}': configuration keys are case-sensitive.`, [ref.server(s.name)], { fix: { kind: 'rename', to: s.name } });
    else if (s) add('warning', 'unknown-key', n, `Unknown top-level key <${name}>; did you mean <${s.name}>? Unknown keys are silently ignored.`, [ref.server(s.name)], { fix: { kind: 'rename', to: s.name } });
    else {
      const loc = whereValid(ctx, n);
      if (loc) add('warning', 'unknown-key', n, `<${name}> is not a top-level server setting.${loc.msg} At the top level ClickHouse ignores it.`, loc.refs, { fix: { kind: 'move', to: loc.parents } });
      else add('info', 'unknown-key', n, `<${name}> is not a known server setting (not in ServerSettings.cpp, the server settings docs, or the reference config). ClickHouse ignores unknown keys unless a component reads them.`, [ref.server(name)]);
    }
  }

  // Settings configured by path (logger.level, openSSL.server.*, query_cache.*, distributed_ddl.*, …).
  for (const [name, s] of Object.entries(schema.serverWithPath)) {
    const n = getPath(cfg, s.path);
    if (!n) continue;
    ctx.recognized.push({ scope: 'server', name: s.path, type: s.t, def: s.d, value: n.text != null ? n.text.trim() : '', line: n.line, file: n.textFile || n.file, url: ref.server(s.path.split('.')[0]).url, desc: s.desc });
    typeCheck(ctx, n, s.t, {}, [ref.server(docKeyForPath(ctx.schema, s.path, name)), ref.source(SRC.serverSettings, 'ServerSettings.cpp')]);
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
      if (parent.startsWith('openSSL') && /^(invalidCertificateHandler|privateKeyPassphraseHandler)$/.test(c.name)) continue;
      unknownChild(ctx, c, [...kids], [ref.server(parent.split('.')[0])], { sev: 'info' });
    }
  }
  const tlsNone = ['openSSL.client.verificationMode'].map((p) => getPath(cfg, p)).filter((n) => n && textOf(n) === 'none');
  for (const n of tlsNone) add('warning', 'tls-none', ctx.valueNode(n), 'openSSL.client verificationMode is none: certificates of servers this node connects to (replicas, Keeper Raft peers) are not verified.', [ref.server('openSSL'), ref.source(SRC.keeperServer, 'KeeperServer.cpp')]);
}

function docKeyForPath(schema, path, name) {
  const top = path.split('.')[0];
  if (schema.docPaths[path]) return path;
  if (schema.docPaths[name]) return name;
  return top;
}

// ------------------------------------------------------------------ keeper
function checkKeeper(ctx, ks) {
  const { schema, add } = ctx;
  const kref = ref.keeper();
  for (const c of ks.children) {
    if (c.name === 'include') continue;
    const def = KEEPER_KEYS[c.name];
    if (!def) {
      if (schema.coordination[c.name]) {
        add('warning', 'coord-misplaced', c, `<${c.name}> is a coordination setting; move it into <keeper_server><coordination_settings>. Here it is ignored.`, [ref.keeperCoordination()], { fix: { kind: 'move', to: ['keeper_server.coordination_settings'] } });
        continue;
      }
      unknownChild(ctx, c, Object.keys(KEEPER_KEYS), [kref]);
      continue;
    }
    if (def.section) continue;
    ctx.recognized.push({ scope: 'keeper', name: `keeper_server.${c.name}`, type: def.t, def: '', value: textOf(c) ?? '', line: c.line, file: c.textFile || c.file, url: kref.url });
    typeCheck(ctx, c, def.t, { parser: def.p || 'setting' }, [kref]);
  }

  const get = (k) => child(ks, k);
  const required = ['server_id', 'raft_configuration'];
  for (const k of required) if (!get(k) && !ks.attrs.has('incl')) add('error', 'keeper-required', ks, `<keeper_server> is missing <${k}>.`, [kref, ref.source(SRC.keeperState, 'KeeperStateManager.cpp')]);
  if (!get('log_storage_path') && !get('storage_path') && !get('log_storage_disk'))
    add('warning', 'keeper-log-path', ks, 'No <log_storage_path> (or <storage_path>/<log_storage_disk>); Keeper falls back to a default location under the server path. Set it explicitly, ideally on a dedicated disk.', [kref, ref.keeper('using-disks-with-keeper', 'Using disks with Keeper')]);
  if (!get('snapshot_storage_path') && !get('storage_path') && !get('snapshot_storage_disk'))
    add('warning', 'keeper-snap-path', ks, 'No <snapshot_storage_path> (or <storage_path>/<snapshot_storage_disk>); Keeper falls back to a default location.', [kref]);

  // remove_orphaned_nodes_on_startup requires digest_enabled = false (docs).
  const ron = get('remove_orphaned_nodes_on_startup');
  if (ron && POCO_BOOL.test(textOf(ron) ?? '') && isTrue(textOf(ron))) {
    const de = get('digest_enabled');
    if (!de || isTrue(textOf(de))) add('error', 'orphaned-digest', ron, 'remove_orphaned_nodes_on_startup requires digest_enabled to be false.', [kref]);
    add('warning', 'orphaned-recovery', ron, 'remove_orphaned_nodes_on_startup is a single-node recovery switch; remove it once the node has recovered.', [kref]);
  }

  // four_letter_word_white_list
  const fl = get('four_letter_word_white_list');
  if (fl && textOf(fl) && textOf(fl) !== '*') {
    for (const w of textOf(fl).split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!schema.fourLetterWords.includes(w)) add('warning', '4lw', ctx.valueNode(fl), `Unknown four letter word command '${w}'.`, [ref.keeper4lw(), ref.source(SRC.coordination, 'CoordinationSettings.cpp')]);
    }
  }
  const sd = get('superdigest');
  if (sd && textOf(sd) && !/^super:.+/.test(textOf(sd))) add('error', 'superdigest', ctx.valueNode(sd), "Incorrect superdigest: must be 'super:base64string'.", [ref.source(SRC.keeperServer, 'KeeperServer.cpp')]);
  const pw = ['client_password', 'client_password_sha256_hex', 'client_password_double_sha1_hex'].filter((k) => get(k));
  if (pw.length > 1) add('error', 'keeper-auth', get(pw[1]), 'Only one client password type is allowed in the Keeper config.', [ref.source(SRC.keeperState, 'KeeperStateManager.cpp')]);

  // coordination_settings: unknown keys throw UNKNOWN_SETTING at startup.
  const cs = get('coordination_settings');
  if (cs) {
    const names = Object.keys(schema.coordination);
    for (const c of cs.children) {
      if (c.name === 'include') continue;
      const def = schema.coordination[c.name];
      if (!def) {
        if (removedSetting(ctx, 'coordination', c, 'coordination setting', 'Keeper refuses to start (UNKNOWN_SETTING)', [ref.keeperCoordination()])) continue;
        const s = suggest(c.name, names);
        const loc = s ? null : whereValid(ctx, c);
        add('error', 'unknown-coord', c, `Unknown coordination setting <${c.name}>${s ? `; did you mean <${s.name}>?` : ''}. Keeper refuses to start (UNKNOWN_SETTING "in Coordination settings config").${loc ? loc.msg : ''}`,
          [ref.keeperCoordination(), ref.source(SRC.coordination, 'CoordinationSettings.cpp (loadFromConfig)'), ...(loc ? loc.refs : [])], { fix: s ? { kind: 'rename', to: s.name } : loc ? { kind: 'move', to: loc.parents } : undefined });
        continue;
      }
      ctx.recognized.push({ scope: 'coordination', name: `coordination_settings.${c.name}`, type: def.t, def: def.d, value: textOf(c) ?? '', line: c.line, file: c.textFile || c.file, url: ref.keeperCoordination().url, desc: def.desc });
      lifecycle(ctx, c, 'coordination setting', c.name, def, ref.keeperCoordination(), 'coordination');
      typeCheck(ctx, c, def.t, {}, [ref.keeperCoordination(), ref.source(SRC.coordination, 'CoordinationSettings.cpp')]);
    }
    const num = (k) => { const n = child(cs, k); const v = n && textOf(n); return v && /^\d+$/.test(v) ? Number(v) : null; };
    const lo = num('election_timeout_lower_bound_ms') ?? 1000, hi = num('election_timeout_upper_bound_ms') ?? 2000, hb = num('heart_beat_interval_ms') ?? 500;
    if (lo > hi) add('error', 'election-bounds', child(cs, 'election_timeout_lower_bound_ms') || cs, `election_timeout_lower_bound_ms (${lo}) must be <= election_timeout_upper_bound_ms (${hi}).`, [ref.keeperCoordination()]);
    else if (lo === hi && (child(cs, 'election_timeout_lower_bound_ms') || child(cs, 'election_timeout_upper_bound_ms'))) add('info', 'election-equal', child(cs, 'election_timeout_lower_bound_ms') || cs, 'Election timeout lower and upper bounds are equal; the docs recommend they differ.', [ref.keeperCoordination()]);
    if (hb >= lo && (child(cs, 'heart_beat_interval_ms') || child(cs, 'election_timeout_lower_bound_ms'))) add('warning', 'heartbeat', child(cs, 'heart_beat_interval_ms') || cs, `heart_beat_interval_ms (${hb}) is not below election_timeout_lower_bound_ms (${lo}); followers will start elections before heartbeats arrive.`, [ref.keeperCoordination()]);
    const minS = num('min_session_timeout_ms'), maxS = num('session_timeout_ms');
    if (minS != null && maxS != null && minS > maxS) add('warning', 'session-bounds', child(cs, 'min_session_timeout_ms'), `min_session_timeout_ms (${minS}) is greater than session_timeout_ms (${maxS}).`, [ref.keeperCoordination()]);
    const sdist = num('snapshot_distance');
    if (sdist != null && sdist < 10000) add('warning', 'snapshot-distance', child(cs, 'snapshot_distance'), `Very small snapshot_distance (${sdist}); Keeper logs a warning because it degrades performance.`, [ref.keeperCoordination(), ref.source(SRC.keeperServer, 'KeeperServer.cpp')]);
    const fs = child(cs, 'force_sync');
    if (fs && textOf(fs) && SETTING_BOOL.test(textOf(fs)) && !isTrue(textOf(fs))) add('info', 'force-sync', fs, 'force_sync is disabled: coordination log writes are not fsynced, risking data loss on power failure.', [ref.keeperCoordination()]);
    const qr = child(cs, 'quorum_reads');
    if (qr && isTrue(textOf(qr))) add('info', 'quorum-reads', qr, 'quorum_reads is enabled; Keeper logs "Quorum reads enabled, Keeper will work slower."', [ref.source(SRC.keeperServer, 'KeeperServer.cpp')]);
  }

  // feature_flags
  const ff = get('feature_flags');
  if (ff) {
    for (const c of ff.children) {
      if (!schema.keeperFeatureFlags.includes(c.name.toLowerCase())) {
        const s = suggest(c.name, schema.keeperFeatureFlags);
        add('error', 'feature-flag', c, `Invalid Keeper feature flag <${c.name}>${s ? `; did you mean <${s.name}>?` : ''}. Keeper refuses to start.`, [ref.keeperFlags(), ref.source(SRC.keeperContext, 'KeeperContext.cpp (initializeFeatureFlags)')]);
        continue;
      }
      typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [ref.keeperFlags()]);
    }
  }

  // http_control
  const hc = get('http_control');
  if (hc) {
    for (const c of hc.children) {
      if (!['port', 'secure_port', 'readiness'].includes(c.name)) unknownChild(ctx, c, ['port', 'secure_port', 'readiness'], [ref.keeperHttp()], { sev: 'info' });
      else if (c.name === 'port' || c.name === 'secure_port') typeCheck(ctx, c, 'Port', { parser: 'poco' }, [ref.keeperHttp()]);
    }
  }

  // raft_configuration — mirrors KeeperStateManager::parseServersConfiguration.
  const rc = get('raft_configuration');
  if (rc && !rc.attrs.has('incl') && !rc.attrs.has('from_zk')) {
    const sref = ref.source(SRC.keeperState, 'KeeperStateManager.cpp (parseServersConfiguration)');
    const servers = [];
    for (const c of rc.children) {
      if (c.name === 'secure') { typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [kref]); continue; }
      if (!c.name.startsWith('server')) { unknownChild(ctx, c, ['server', 'secure'], [kref], { sev: 'warning', what: 'raft_configuration element (ignored)' }); continue; }
      const entry = { node: c };
      for (const k of ['id', 'hostname', 'port']) {
        const els = childrenNamed(c, k);
        if (els.length > 1) add('error', 'raft-multi', els[1], `Multiple <${k}> specified for a single <server>.`, [sref]);
        if (!els.length) add('error', 'raft-missing', c, `<server> is missing required <${k}>.`, [kref, sref]);
      }
      for (const s of c.children) {
        const d = RAFT_SERVER_KEYS[s.name];
        if (!d) { unknownChild(ctx, s, Object.keys(RAFT_SERVER_KEYS), [kref]); continue; }
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
    const ids = new Map(), eps = new Map();
    for (const s of servers) {
      if (s.id != null) {
        if (ids.has(s.id)) add('error', 'raft-dup-id', s.node, `Duplicate raft server id ${s.id} (also used on line ${ids.get(s.id).line}).`, [sref]);
        else ids.set(s.id, s.node);
      }
      if (s.hostname && s.port) {
        const ep = `${s.hostname}:${s.port}`;
        if (eps.has(ep)) add('error', 'raft-dup-endpoint', s.node, `Duplicate raft endpoint ${ep} (also on line ${eps.get(ep).line}).`, [sref]);
        else eps.set(ep, s.node);
      }
    }
    const sid = textOf(get('server_id'));
    if (sid && servers.length && !ids.has(sid) && !get('server_id').attrs.has('from_env') && !get('server_id').attrs.has('incl'))
      add('error', 'raft-self', get('server_id'), `server_id ${sid} is not present in <raft_configuration> ("Our server id ${sid} not found in raft_configuration section").`, [sref]);
    if (servers.length && servers.every((s) => s.follower)) add('error', 'raft-followers', rc, 'Every server has <start_as_follower>; at least one must be able to start as leader.', [sref]);
    const hn = servers.map((s) => s.hostname).filter(Boolean);
    const isLocal = (h) => h === 'localhost' || /^127\./.test(h) || h === '::1';
    const hostChecks = !get('hostname_checks_enabled') || isTrue(textOf(get('hostname_checks_enabled')));
    if (hostChecks && hn.includes('localhost') && hn.some((h) => !isLocal(h)))
      add('error', 'raft-localhost-mix', rc, "Mixing 'localhost' and non-local hostnames in raft_configuration is not allowed (different hosts resolve 'localhost' to themselves).", [sref]);
    else if (hostChecks && hn.filter(isLocal).length > 1 && hn.some((h) => !isLocal(h)))
      add('error', 'raft-local-multi', rc, 'A local address is specified more than once alongside non-local hostnames; a single host could vote multiple times.', [sref]);
    if (hn.some((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h) && !isLocal(h)))
      add('info', 'raft-ip', rc, 'Raft servers are addressed by IP. The docs recommend hostnames if a host can change, since changing an endpoint means removing and re-adding the server.', [ref.keeper('internal-coordination-settings', 'Keeper: raft_configuration notes')]);
    const voters = servers.filter((s) => !s.learner).length;
    if (voters > 1 && voters % 2 === 0)
      add('warning', 'raft-even', rc, `${voters} voting members: an even-sized Raft quorum tolerates no more failures than ${voters - 1} members (majority ${voters / 2 + 1}). Use an odd number of voters.`, [ref.keeperQuorum()]);
    if (voters === 1 && servers.length === 1) add('info', 'raft-single', rc, 'Single-node Keeper: no fault tolerance.', [ref.keeperQuorum()]);
    // Raft port must not collide with a client port of this server.
    const self = servers.find((s) => s.id === sid);
    if (self && self.port) {
      for (const p of RAFT_CONFLICT_PORTS) {
        const n = getPath(ctx.cfg, p);
        if (n && textOf(n) === self.port) add('error', 'raft-port', self.node, `Raft port ${self.port} of this server equals <${p}>; Keeper refuses to start.`, [sref]);
      }
    }
  }
}

function isTrue(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(s)) return true;
  if (/^[+-]?\d+$/.test(s)) return Number(s) !== 0;
  return false;
}

// ------------------------------------------------------------------ ports
function checkPorts(ctx) {
  const seen = new Map();
  for (const p of PORT_PATHS) {
    const n = getPath(ctx.cfg, p);
    if (!n || ctx.hasSubst(n)) continue;
    if (!ctx.schema.server[p] && !ctx.schema.serverWithPath[p]) typeCheck(ctx, n, 'Port', { parser: 'poco' }, [ref.server(p.split('.')[0])]);
    const v = textOf(n);
    if (!v || !/^\d+$/.test(v)) continue;
    if (Number(v) > 65535) { if (ctx.schema.server[p]) ctx.add('error', 'port-range', ctx.valueNode(n), `<${p}> = ${v} is not a valid TCP port (0-65535).`, [ref.server(p)]); continue; }
    if (seen.has(v)) ctx.add('error', 'port-dup', n, `Port ${v} is used by both <${seen.get(v)}> and <${p}>; the second listener fails with "Address already in use".`, [ref.server(p.split('.')[0])]);
    else seen.set(v, p);
  }
}

// ------------------------------------------------------------------ users / profiles / quotas
function checkUsersFile(ctx) {
  const { cfg, schema, add } = ctx;
  const profilesEl = child(cfg, 'profiles');
  const usersEl = child(cfg, 'users');
  const quotasEl = child(cfg, 'quotas');
  const profileNames = new Set(profilesEl ? profilesEl.children.map((c) => c.name) : []);
  const quotaNames = new Set(quotasEl ? quotasEl.children.map((c) => c.name) : []);
  const customPrefixes = (textOf(child(cfg, 'custom_settings_prefixes')) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const sessionNames = Object.keys(schema.session);
  const uref = ref.source(SRC.usersParser, 'UsersConfigParser.cpp');

  const checkSettingName = (n, scope) => {
    const name = n.name;
    const real = schema.session[name] ? name : schema.sessionAliases[name];
    if (real) return { def: schema.session[real], name: real };
    if (customPrefixes.some((p) => name.startsWith(p))) return { custom: true };
    return null;
  };

  if (profilesEl) {
    for (const prof of profilesEl.children) {
      if (prof.name === 'include') continue;
      for (const s of prof.children) {
        if (s.name === 'include') continue;
        if (s.name === 'profile') {
          const parent = textOf(s);
          if (parent && !profileNames.has(parent)) add('warning', 'profile-parent', ctx.valueNode(s), `Parent profile '${parent}' is not defined in this file. ClickHouse fails with "Parent profile '${parent}' was not found" unless another users.d file defines it.`, [uref]);
          continue;
        }
        if (s.name === 'constraints' || s.name.startsWith('constraints[')) { checkConstraints(ctx, s, customPrefixes); continue; }
        const r = checkSettingName(s, 'session');
        if (!r) {
          if (removedSetting(ctx, 'session', s, 'setting', 'loading the users config fails with UNKNOWN_SETTING', [ref.session(s.name), uref])) continue;
          const sug = suggest(s.name, sessionNames);
          const isServer = schema.server[s.name] && !schema.serverProfileAllowlist.includes(s.name);
          const loc = sug || isServer ? null : whereValid(ctx, s);
          add('error', 'unknown-setting', s, `Unknown setting <${s.name}> in profile '${prof.name}'${sug ? `; did you mean <${sug.name}>?` : '.'}${isServer ? ' It is a server setting: move it to the top level of config.xml.' : loc ? loc.msg : ''} Loading the users config fails with UNKNOWN_SETTING.`,
            [isServer ? ref.server(s.name) : ref.session(sug ? sug.name : s.name), uref, ...(loc ? loc.refs : [])], { fix: sug ? { kind: 'rename', to: sug.name } : isServer ? { kind: 'move', to: [''] } : loc ? { kind: 'move', to: loc.parents } : undefined });
          continue;
        }
        if (r.custom) continue;
        ctx.recognized.push({ scope: `profile ${prof.name}`, name: r.name, type: r.def.t, def: r.def.d, value: textOf(s) ?? '', line: s.line, file: s.textFile || s.file, url: ref.session(r.name).url, desc: r.def.desc });
        lifecycle(ctx, s, 'setting', r.name, r.def, ref.session(r.name), 'profile');
        if (r.name !== s.name) add('info', 'alias', s, `<${s.name}> is an alias of <${r.name}>.`, [ref.session(r.name)]);
        typeCheck(ctx, s, r.def.t, {}, [ref.session(r.name)]);
      }
    }
  }

  if (usersEl) {
    for (const u of usersEl.children) {
      if (u.name === 'include') continue;
      const keys = u.children.map((c) => c.name);
      const auth = USER_AUTH_KEYS.filter((k) => keys.includes(k));
      const hasAuthMethods = keys.includes('auth_methods');
      if (hasAuthMethods && auth.length) add('error', 'auth-both', u, `User '${u.name}' sets both <auth_methods> and <${auth[0]}>; use one or the other.`, [ref.users('multiple-authentication-methods', 'Multiple authentication methods'), uref]);
      if (auth.length > 1) add('error', 'auth-multi', child(u, auth[1]), `User '${u.name}' has several authentication methods (${auth.join(', ')}); specify exactly one (or use <auth_methods>).`, [ref.users('user-namepassword', 'user_name/password'), uref]);
      if (!auth.length && !hasAuthMethods && !u.attrs.has('incl') && !u.attrs.has('remove'))
        add('info', 'auth-none', u, `User '${u.name}' has no authentication method here. Fine for a users.d fragment that only overrides other fields; otherwise loading fails ("At least one authentication type … must be specified").`, [uref]);
      for (const c of u.children) {
        if (!USER_KEYS.includes(c.name) && c.name !== 'include') unknownChild(ctx, c, USER_KEYS, [ref.users()], { sev: 'warning', what: `user property in '${u.name}'` });
      }
      const sha = child(u, 'password_sha256_hex');
      if (sha && textOf(sha) && !ctx.hasSubst(sha) && !/^[0-9a-fA-F]{64}$/.test(textOf(sha)))
        add('error', 'sha256-len', ctx.valueNode(sha), `password_sha256_hex must be 64 hex characters (32 bytes); got ${textOf(sha).length}.`, [ref.users('user-namepassword', 'password_sha256_hex'), ref.source(SRC.authData, 'AuthenticationData.cpp')]);
      const dsha = child(u, 'password_double_sha1_hex');
      if (dsha && textOf(dsha) && !ctx.hasSubst(dsha) && !/^[0-9a-fA-F]{40}$/.test(textOf(dsha)))
        add('error', 'dsha1-len', ctx.valueNode(dsha), `password_double_sha1_hex must be 40 hex characters (20 bytes); got ${textOf(dsha).length}.`, [ref.users('user-namepassword'), ref.source(SRC.authData, 'AuthenticationData.cpp')]);
      const pw = child(u, 'password');
      const nets = child(u, 'networks');
      const openNet = nets && nets.children.some((c) => c.name.startsWith('ip') && ['::/0', '0.0.0.0/0', '::', '0.0.0.0'].includes(textOf(c)));
      if (pw && !ctx.hasSubst(pw) && textOf(pw)) add('info', 'plaintext-password', pw, `User '${u.name}' has a plaintext <password>. The docs recommend <password_sha256_hex>.`, [ref.users('user-namepassword', 'user_name/password')]);
      if ((child(u, 'no_password') || (pw && !ctx.hasSubst(pw) && !textOf(pw))) && (openNet || !nets))
        add('warning', 'open-user', u, `User '${u.name}' has no password${openNet ? ' and accepts connections from any address' : ''}. Restrict <networks> or set a password.`, [ref.users('user-namenetworks', 'user_name/networks')]);
      if (nets) {
        for (const c of nets.children) {
          if (c.name === 'include') continue;
          if (!c.name.startsWith('ip') && !c.name.startsWith('host')) add('error', 'networks-key', c, `Unknown address pattern type <${c.name}> in networks; use <ip>, <host> or <host_regexp>.`, [ref.users('user-namenetworks', 'user_name/networks'), uref]);
          else if (c.name === 'ip' && textOf(c) && !validIpOrCidr(textOf(c))) add('error', 'networks-ip', ctx.valueNode(c), `'${textOf(c)}' is not a valid IP address or subnet.`, [ref.users('user-namenetworks', 'user_name/networks')]);
          else if (c.name === 'host_regexp' && textOf(c)) { try { new RegExp(textOf(c)); } catch { add('warning', 'networks-regexp', ctx.valueNode(c), `host_regexp '${textOf(c)}' does not compile as a regular expression.`, [ref.users('user-namenetworks')]); } }
        }
      }
      const pr = child(u, 'profile');
      if (pr && textOf(pr) && profilesEl && !profileNames.has(textOf(pr))) add('warning', 'user-profile', ctx.valueNode(pr), `Profile '${textOf(pr)}' is not defined in this file ("Profile ${textOf(pr)} was not found" unless defined elsewhere).`, [ref.users('user-nameprofile', 'user_name/profile'), uref]);
      const qu = child(u, 'quota');
      if (qu && textOf(qu) && quotasEl && !quotaNames.has(textOf(qu))) add('warning', 'user-quota', ctx.valueNode(qu), `Quota '${textOf(qu)}' is not defined in this file.`, [ref.users('user-namequota', 'user_name/quota')]);
      if (child(u, 'grants') && ['allow_databases', 'databases', 'allow_dictionaries', 'access_management', 'named_collection_control', 'named_collection_admin', 'show_named_collections_secrets'].some((k) => child(u, k) && (k.startsWith('allow') || k === 'databases' || isTrue(textOf(child(u, k))))))
        add('error', 'grants-conflict', child(u, 'grants'), "Any other access control settings can't be specified with <grants>.", [ref.users('grants-user-setting', 'grants'), uref]);
      for (const b of ['access_management', 'named_collection_control', 'show_named_collections', 'show_named_collections_secrets']) {
        const n = child(u, b);
        if (n) typeCheck(ctx, n, 'Bool', { parser: 'poco' }, [ref.users(`${b}-user-setting`, b)]);
      }
    }
  }

  if (quotasEl) {
    const qkeys = ['queries', 'query_selects', 'query_inserts', 'errors', 'result_rows', 'result_bytes', 'read_rows', 'read_bytes', 'execution_time',
      'written_bytes', 'failed_sequential_authentications', 'queries_per_normalized_hash'];
    for (const q of quotasEl.children) {
      for (const iv of childrenNamed(q, 'interval')) {
        const d = child(iv, 'duration');
        if (!d) add('error', 'quota-duration', iv, `Quota '${q.name}' interval has no <duration>.`, [ref.users()]);
        for (const c of iv.children) {
          if (c.name === 'duration') typeCheck(ctx, c, 'UInt64', { parser: 'poco' }, [ref.users()]);
          else if (c.name === 'randomize') typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [ref.users()]);
          else if (qkeys.includes(c.name)) { if (textOf(c) && !/^\d+(\.\d+)?$/.test(textOf(c))) add('error', 'quota-value', ctx.valueNode(c), `<${c.name}> must be a number.`, [ref.users()]); }
          else unknownChild(ctx, c, [...qkeys, 'duration', 'randomize'], [ref.users()], { what: 'quota limit' });
        }
      }
    }
  }
}

function checkConstraints(ctx, cons, customPrefixes) {
  const { schema, add } = ctx;
  const kinds = ['min', 'max', 'readonly', 'const', 'changeable_in_readonly', 'disallowed'];
  for (const s of cons.children) {
    const name = s.name;
    let def = schema.session[name] || schema.session[schema.sessionAliases[name]];
    if (!def && name.startsWith('merge_tree_')) def = schema.mergeTree[name.slice('merge_tree_'.length)];
    if (!def && !customPrefixes.some((p) => name.startsWith(p))) {
      const sug = suggest(name, Object.keys(schema.session));
      add('error', 'constraint-unknown', s, `Constraint on unknown setting <${name}>${sug ? `; did you mean <${sug.name}>?` : ''}.`, [ref.constraints('defining-constraints')]);
      continue;
    }
    let writ = 0;
    for (const c of s.children) {
      if (!kinds.includes(c.name)) { add('error', 'constraint-kind', c, `Setting ${c.name} value for ${name} isn't supported; use one of ${kinds.join(', ')}.`, [ref.constraints('types-of-constraints'), ref.source(SRC.usersParser, 'UsersConfigParser.cpp')]); continue; }
      if (['readonly', 'const', 'changeable_in_readonly'].includes(c.name)) writ++;
      if ((c.name === 'min' || c.name === 'max') && def) typeCheck(ctx, c, def.t, {}, [ref.constraints('types-of-constraints')]);
    }
    if (writ > 1) add('error', 'constraint-writability', s, `Not more than one of const/readonly/changeable_in_readonly is allowed for ${name}.`, [ref.constraints('types-of-constraints'), ref.source(SRC.usersParser, 'UsersConfigParser.cpp')]);
  }
}

function validIpOrCidr(v) {
  const [addr, bits, ...rest] = v.split('/');
  if (rest.length) return false;
  const v4 = isIPv4(addr);
  const v6 = !v4 && isIPv6(addr);
  if (!v4 && !v6) return false;
  if (bits === undefined) return true;
  if (/^\d+$/.test(bits)) return Number(bits) <= (v4 ? 32 : 128);
  return v4 && isIPv4(bits); // netmask form
}

// ------------------------------------------------------------------ host and address values
// Elements whose value is a single host: an IP address, or a DNS name where allowed.
const HOST_KEYS = { listen_host: true, interserver_listen_host: true, interserver_http_host: true, host: true, hostname: true };
function checkHosts(ctx) {
  walk(ctx.cfg, (n) => {
    if (!HOST_KEYS[n.name] || n.children.length || ctx.hasSubst(n)) return;
    const v = textOf(n);
    if (!v || /[{}$]/.test(v)) return;          // empty (reported elsewhere) or macro / env placeholder
    const path = ctx.relPath(n);
    if (path.includes('networks')) return;       // users networks: host is matched as given; ip is checked separately
    const r = checkHost(v.trim());
    if (r.ok) return;
    const top = path[0] === n.name ? n.name : path[0];
    ctx.add('error', 'bad-address', ctx.valueNode(n), `<${n.name}>: ${r.msg}`, [path[0] === 'keeper_server' ? ref.keeper() : ref.server(top)]);
  });
}

// ------------------------------------------------------------------ remote_servers — mirrors Cluster.cpp
function checkRemoteServers(ctx) {
  const rs = child(ctx.cfg, 'remote_servers');
  if (!rs || ctx.hasSubst(rs)) return;
  const { add } = ctx;
  const cref = ref.source(SRC.cluster, 'Cluster.cpp');
  const dref = ref.server('remote_servers');
  const hasTcpPort = !!getPath(ctx.cfg, 'tcp_port');
  for (const cl of rs.children) {
    if (cl.name === 'include') continue;
    if (cl.name.includes('.')) add('error', 'cluster-dot', cl, `Cluster names with dots are not supported: '${cl.name}'.`, [cref]);
    if (child(cl, 'discovery')) continue;
    const elems = cl.children.filter((c) => !['secret', 'allow_distributed_ddl_queries', 'include'].includes(c.name));
    if (!elems.length && !ctx.hasSubst(cl)) { add('error', 'cluster-empty', cl, `Cluster '${cl.name}' has no <shard> or <node> elements.`, [cref, dref]); continue; }
    const named = elems.filter((e) => child(e, 'name')).length;
    if (named && named !== elems.length) add('error', 'shard-names', cl, `Cluster '${cl.name}': <name> must be specified for every shard (node) or for none.`, [cref]);
    const adr = child(cl, 'allow_distributed_ddl_queries');
    if (adr) typeCheck(ctx, adr, 'Bool', { parser: 'poco' }, [dref]);
    for (const sh of elems) {
      if (!sh.name.startsWith('shard') && !sh.name.startsWith('node')) { add('error', 'cluster-elem', sh, `Unknown element in config: <${sh.name}> (cluster '${cl.name}' accepts only <shard>, <node>, <secret>, <allow_distributed_ddl_queries>).`, [cref, dref]); continue; }
      if (sh.name.startsWith('node')) { checkReplica(ctx, sh, hasTcpPort, cref, dref); continue; }
      let replicas = 0;
      for (const r of sh.children) {
        if (['weight', 'internal_replication', 'name', 'include'].includes(r.name) || r.name.startsWith('weight') || r.name.startsWith('internal_replication') || r.name.startsWith('name')) {
          if (r.name === 'internal_replication') typeCheck(ctx, r, 'Bool', { parser: 'poco' }, [dref]);
          if (r.name === 'weight') typeCheck(ctx, r, 'UInt32', { parser: 'poco' }, [dref]);
          continue;
        }
        if (!r.name.startsWith('replica')) { add('error', 'shard-elem', r, `Unknown element in config: <${r.name}> (a <shard> accepts <replica>, <weight>, <internal_replication>, <name>).`, [cref]); continue; }
        replicas++;
        checkReplica(ctx, r, hasTcpPort, cref, dref);
      }
      if (!replicas) add('error', 'shard-empty', sh, 'Shard contains zero replicas.', [cref]);
    }
  }
}

function checkReplica(ctx, r, hasTcpPort, cref, dref) {
  const keys = ['host', 'port', 'user', 'password', 'secure', 'compression', 'priority', 'default_database', 'bind_host', 'proto_caps', 'quota_key'];
  if (!child(r, 'host')) ctx.add('error', 'replica-host', r, `<${r.name}> is missing <host>.`, [cref, dref]);
  if (!child(r, 'port')) ctx.add(hasTcpPort ? 'info' : 'warning', 'replica-port', r, `<${r.name}> has no <port>; it defaults to the server's tcp_port${hasTcpPort ? '' : ' (not set in this file); if that is unset, loading fails with "Port is not specified in cluster configuration"'}.`, [cref]);
  for (const c of r.children) {
    if (!keys.includes(c.name)) { unknownChild(ctx, c, keys, [dref], { sev: 'info' }); continue; }
    if (c.name === 'port') typeCheck(ctx, c, 'Port', { parser: 'poco' }, [dref]);
    if (c.name === 'priority') typeCheck(ctx, c, 'Int32', { parser: 'poco' }, [dref]);
    if (c.name === 'secure' || c.name === 'compression') typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [dref]);
  }
}

// ------------------------------------------------------------------ zookeeper
function checkZookeeper(ctx) {
  const zks = [];
  const z = child(ctx.cfg, 'zookeeper');
  if (z) zks.push(z);
  const aux = child(ctx.cfg, 'auxiliary_zookeepers');
  if (aux) zks.push(...aux.children);
  const zref = ref.server('zookeeper');
  const keys = ['node', 'session_timeout_ms', 'operation_timeout_ms', 'connection_timeout_ms', 'root', 'identity', 'zookeeper_load_balancing',
    'fallback_session_lifetime', 'use_compression', 'use_xid_64', 'pass_opentelemetry_tracing_context', 'secure', 'implementation', 'availability_zone_autodetect',
    'prefer_local_availability_zone', 'send_receive_timeout_ms', 'enable_fault_injections_during_startup', 'send_fault_probability', 'recv_fault_probability',
    'send_sleep_probability', 'send_sleep_ms', 'keeper_multiread_batch_size', 'num_connection_retries', 'path_acl', 'sessions_path', 'last_zxid_seen',
    'chroot', 'get_priority_load_balancing_hostnames', 'enable_get_children_optimization'];
  for (const zk of zks) {
    if (ctx.hasSubst(zk)) continue;
    const nodes = childrenNamed(zk, 'node');
    if (!nodes.length && !zk.children.some((c) => c.name === 'include')) ctx.add('error', 'zk-nodes', zk, `<${zk.name}> has no <node> endpoints.`, [zref]);
    for (const nd of nodes) {
      if (!child(nd, 'host')) ctx.add('error', 'zk-host', nd, '<node> is missing <host>.', [zref]);
      for (const c of nd.children) {
        if (c.name === 'port') typeCheck(ctx, c, 'Port', { parser: 'poco' }, [zref]);
        else if (c.name === 'secure') typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [zref]);
        else if (!['host', 'availability_zone'].includes(c.name)) unknownChild(ctx, c, ['host', 'port', 'secure', 'availability_zone'], [zref], { sev: 'info' });
      }
      if (!child(nd, 'port')) ctx.add('info', 'zk-port', nd, '<node> has no <port>; the client default (2181) is used.', [zref]);
    }
    for (const c of zk.children) {
      if (c.name === 'node' || c.name === 'include') continue;
      if (!keys.includes(c.name)) { unknownChild(ctx, c, keys, [zref], { sev: 'info' }); continue; }
      if (['session_timeout_ms', 'operation_timeout_ms', 'connection_timeout_ms'].includes(c.name)) typeCheck(ctx, c, 'Int32', { parser: 'poco' }, [zref]);
      if (c.name === 'root' && textOf(c) && !textOf(c).startsWith('/')) ctx.add('error', 'zk-root', ctx.valueNode(c), '<root> must start with \'/\'.', [zref]);
      if (c.name === 'identity' && textOf(c) && !textOf(c).includes(':')) ctx.add('warning', 'zk-identity', ctx.valueNode(c), "<identity> should be 'user:password'.", [zref]);
      if (c.name === 'zookeeper_load_balancing' && textOf(c) && !ZK_LB.includes(textOf(c))) ctx.add('error', 'zk-lb', ctx.valueNode(c), `'${textOf(c)}' is not a valid zookeeper_load_balancing; allowed: ${ZK_LB.join(', ')}.`, [zref]);
      if (['use_compression', 'use_xid_64', 'pass_opentelemetry_tracing_context', 'secure'].includes(c.name)) typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [zref]);
    }
  }
}

// ------------------------------------------------------------------ system log tables — mirrors SystemLog.cpp
function checkSystemLogs(ctx) {
  const known = new Set(SYSTEM_LOG_KEYS);
  for (const p of ctx.schema.refPaths.server) {
    const parts = p.split('.');
    if (parts.length === 2 && SYSTEM_LOGS.includes(parts[0])) known.add(parts[1]);
  }
  for (const name of SYSTEM_LOGS) {
    const sec = child(ctx.cfg, name);
    if (!sec || sec.attrs.has('remove')) continue;
    const dref = ref.server(name);
    const sref = ref.source(SRC.systemLog, 'SystemLog.cpp');
    if (child(sec, 'engine')) {
      for (const k of ['partition_by', 'ttl', 'order_by', 'storage_policy', 'settings']) {
        const c = child(sec, k);
        if (c) ctx.add('error', 'syslog-engine', c, `<${name}> sets <engine>, so <${k}> must go inside the engine definition instead; the server refuses to start ("${k} setting doesn't make sense").`, [dref, sref]);
      }
    }
    for (const c of sec.children) {
      if (!known.has(c.name) && c.name !== 'include') { unknownChild(ctx, c, [...known], [dref], { sev: 'info' }); continue; }
      if (SYSTEM_LOG_TYPES[c.name]) typeCheck(ctx, c, SYSTEM_LOG_TYPES[c.name], {}, [dref]);
      if (c.name === 'flush_on_crash' || c.name === 'symbolize' || c.name === 'enable_user_query_log') typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [dref]);
    }
    if (name === 'metric_log') {
      const st = child(sec, 'schema_type');
      if (st && textOf(st) && !['wide', 'transposed', 'transposed_with_wide_view', 'bucketed'].includes(textOf(st)))
        ctx.add('error', 'metric-schema', ctx.valueNode(st), `Unknown schema type '${textOf(st)}' for metric_log.`, [dref, sref]);
    }
    const mx = textOf(child(sec, 'max_size_rows')), rs = textOf(child(sec, 'reserved_size_rows'));
    if (mx && rs && /^\d+$/.test(mx) && /^\d+$/.test(rs) && Number(rs) > Number(mx))
      ctx.add('warning', 'syslog-sizes', child(sec, 'reserved_size_rows'), `reserved_size_rows (${rs}) exceeds max_size_rows (${mx}).`, [dref]);
  }
}

// ------------------------------------------------------------------ storage_configuration
function checkStorage(ctx) {
  const sc = child(ctx.cfg, 'storage_configuration');
  if (!sc || ctx.hasSubst(sc)) return;
  const dref = ref.server('storage_configuration');
  const disksEl = child(sc, 'disks');
  const diskNames = new Set(['default', ...(disksEl ? disksEl.children.map((d) => d.name) : [])]);
  if (disksEl) {
    for (const d of disksEl.children) {
      const t = child(d, 'type');
      if (t && textOf(t) && !DISK_TYPES.includes(textOf(t))) {
        const s = suggest(textOf(t), DISK_TYPES);
        ctx.add('warning', 'disk-type', ctx.valueNode(t), `Unknown disk type '${textOf(t)}'${s ? `; did you mean '${s.name}'?` : ''}.`, [dref]);
      }
      if (t && textOf(t) === 'object_storage' && !child(d, 'object_storage_type')) ctx.add('error', 'disk-ost', d, 'Disk type object_storage requires <object_storage_type>.', [dref]);
      const p = child(d, 'path');
      if (p && textOf(p) && (!t || textOf(t) === 'local') && !textOf(p).endsWith('/')) ctx.add('error', 'disk-path', ctx.valueNode(p), `Disk '${d.name}' path must end with '/'.`, [dref]);
      checkObjectDisk(ctx, d, t ? textOf(t) : null, dref);
      for (const ref_ of ['disk']) {
        const inner = child(d, ref_);
        if (inner && textOf(inner) && !diskNames.has(textOf(inner))) ctx.add('warning', 'disk-ref', ctx.valueNode(inner), `Disk '${d.name}' wraps disk '${textOf(inner)}', which is not defined in this file.`, [dref]);
      }
    }
  }
  const pol = child(sc, 'policies');
  if (pol) {
    for (const p of pol.children) {
      const vols = child(p, 'volumes');
      if (!vols) { ctx.add('error', 'policy-volumes', p, `Storage policy '${p.name}' has no <volumes>.`, [dref]); continue; }
      for (const v of vols.children) {
        const disks = childrenNamed(v, 'disk');
        if (!disks.length) ctx.add('error', 'volume-disks', v, `Volume '${v.name}' in policy '${p.name}' has no <disk>.`, [dref]);
        for (const d of disks) if (textOf(d) && !diskNames.has(textOf(d))) ctx.add('warning', 'volume-disk-ref', ctx.valueNode(d), `Disk '${textOf(d)}' used by policy '${p.name}' is not defined in this file's <disks>.`, [dref]);
      }
      const mr = child(p, 'move_factor');
      if (mr && textOf(mr)) { const f = Number(textOf(mr)); if (!(f >= 0 && f <= 1)) ctx.add('error', 'move-factor', ctx.valueNode(mr), 'move_factor must be between 0 and 1.', [dref]); }
    }
  }
}

/** Mirrors CombinedRotateStrategy::parseRotation; returns an explanation or null when valid. */
function rotationError(r) {
  if (r === 'never') return null;
  let pos = 0;
  const ws = () => { while (pos < r.length && /\s/.test(r[pos])) pos++; };
  const size = () => {
    const save = pos; ws();
    let n = ''; while (pos < r.length && /\d/.test(r[pos])) n += r[pos++];
    ws(); let unit = ''; while (pos < r.length && /[A-Za-z]/.test(r[pos])) unit += r[pos++];
    ws();
    const ok = Number(n) > 0 && (['K', 'M', 'G'].includes(unit) || (unit === '' && (pos === r.length || r[pos] === ',')));
    if (!ok) { pos = save; return { ok: false, unit }; }
    ws(); if (r[pos] === ',') pos++;
    return { ok: true };
  };
  const interval = () => {
    const save = pos; ws();
    while (pos < r.length && /\d/.test(r[pos])) pos++;
    ws(); let unit = ''; while (pos < r.length && /[A-Za-z]/.test(r[pos])) unit += r[pos++];
    if (!['daily', 'weekly', 'monthly', 'seconds', 'milliseconds', 'minutes', 'hours', 'days', 'weeks', 'months'].includes(unit)) { pos = save; return false; }
    ws(); if (r[pos] === ',') pos++;
    return true;
  };
  const time = () => {
    const c = r.indexOf(':', pos);
    if (c < 0) return false;
    const comma = r.indexOf(',', c + 1);
    pos = comma < 0 ? r.length : comma + 1;
    return true;
  };
  let sz = size();
  const iv = interval();
  const tm = time();
  if (!sz.ok) { const s2 = size(); if (s2.ok) sz = s2; }
  ws();
  if ((!sz.ok && !iv && !tm) || pos !== r.length) {
    const unit = /^\s*\d+\s*([A-Za-z]+)/.exec(r)?.[1];
    if (unit && !['K', 'M', 'G'].includes(unit) && /^[kmgt]i?b?$|^[KMGT]i?B$|^[KMGT]i$/i.test(unit))
      return `uses the unit '${unit}'; log rotation sizes accept only K, M or G (uppercase, no "B"), e.g. 100M.`;
    return 'is not a valid rotation: use <size>[K|M|G] (e.g. 100M), an interval (daily, weekly, monthly, <n> minutes|hours|days|weeks|months), [<size>,]<interval>, a time ([day,][hh]:mm) or never.';
  }
  return null;
}

const OBJECT_TYPES = { s3: 's3', s3_plain: 's3', s3_plain_rewritable: 's3', azure_blob_storage: 'azure', azure: 'azure' };
function checkObjectDisk(ctx, d, type, dref) {
  const ost = textOf(child(d, 'object_storage_type'));
  const kind = OBJECT_TYPES[type] || (type === 'object_storage' ? OBJECT_TYPES[ost] : null);
  const has = (k) => !!child(d, k);
  const val = (k) => (textOf(child(d, k)) || '').trim();
  if (kind === 's3') {
    if (!has('endpoint')) ctx.add('error', 's3-endpoint', d, `S3 disk '${d.name}' has no <endpoint> (the bucket URL, e.g. https://bucket.s3.amazonaws.com/root/).`, [dref]);
    else if (val('endpoint') && !/^(https?|s3):\/\//i.test(val('endpoint')) && !ctx.hasSubst(child(d, 'endpoint')))
      ctx.add('error', 's3-endpoint-url', ctx.valueNode(child(d, 'endpoint')), `<endpoint> '${val('endpoint')}' is not an http(s) or s3:// URL.`, [dref]);
    const a = has('access_key_id'), b = has('secret_access_key');
    if (a !== b) ctx.add('error', 's3-creds', child(d, a ? 'access_key_id' : 'secret_access_key'), `S3 disk '${d.name}' sets ${a ? 'access_key_id' : 'secret_access_key'} without ${a ? 'secret_access_key' : 'access_key_id'}; both are needed for static credentials.`, [dref]);
    if (a && b && val('use_environment_credentials') && /^(1|true)$/i.test(val('use_environment_credentials')))
      ctx.add('info', 's3-creds-both', child(d, 'use_environment_credentials'), 'Both static keys and use_environment_credentials are set; the static keys take precedence.', [dref]);
  }
  if (kind === 'azure' && !has('storage_account_url') && !has('connection_string') && !has('endpoint'))
    ctx.add('error', 'azure-endpoint', d, `Azure disk '${d.name}' needs <endpoint>, <storage_account_url> or <connection_string>.`, [dref]);
  if (type === 'encrypted') {
    if (!has('disk')) ctx.add('error', 'enc-disk', d, `Encrypted disk '${d.name}' needs <disk>, the disk it wraps.`, [dref, ref.source('src/Disks/DiskEncrypted.cpp', 'DiskEncrypted.cpp')]);
    const alg = (val('algorithm') || 'aes_128_ctr').toLowerCase();
    const sizes = { aes_128_ctr: 16, aes_192_ctr: 24, aes_256_ctr: 32 };
    if (has('algorithm') && !sizes[alg]) ctx.add('error', 'enc-alg', ctx.valueNode(child(d, 'algorithm')), `Encryption algorithm '${val('algorithm')}' is not supported; use aes_128_ctr, aes_192_ctr or aes_256_ctr.`, [dref]);
    if (sizes[alg]) checkKeys(ctx, d, sizes[alg], alg, [dref, ref.source('src/IO/FileEncryptionCommon.cpp', 'FileEncryptionCommon.cpp')]);
    const p = child(d, 'path');
    if (p && textOf(p) && !textOf(p).endsWith('/')) ctx.add('error', 'enc-path', ctx.valueNode(p), `Encrypted disk '${d.name}' path must end with '/'.`, [dref]);
  }
}

/** key / key_hex children of an encryption section must decode to exactly `bytes` bytes. */
function checkKeys(ctx, sec, bytes, alg, refs) {
  const keys = sec.children.filter((c) => /^key(_hex)?$/.test(c.name));
  const ids = new Map();
  for (const k of keys) {
    if (ctx.hasSubst(k) || k.attrs.has('encrypted_by')) continue;
    const v = textOf(k) ?? '';
    const hex = k.name === 'key_hex';
    if (hex && (!/^[0-9a-fA-F]*$/.test(v) || v.length % 2)) { ctx.add('error', 'enc-key-hex', ctx.valueNode(k), `<key_hex> must be an even number of hex digits ("Cannot read key_hex").`, refs); continue; }
    const len = hex ? v.length / 2 : new TextEncoder().encode(v).length;
    if (len !== bytes) ctx.add('error', 'enc-key-size', ctx.valueNode(k), `${alg} needs a ${bytes}-byte key (${bytes * 2} hex digits in <key_hex>); this key is ${len} bytes.`, refs);
    const id = k.attrs.get('id')?.value ?? '0';
    if (ids.has(id)) ctx.add('error', 'enc-key-id', k, `Two keys use id ${id} ("Multiple keys have the same ID").`, refs);
    ids.set(id, k);
  }
  const cur = child(sec, 'current_key_id');
  if (cur && textOf(cur) && !ids.has(textOf(cur).trim()) && keys.length && !keys.some((k) => ctx.hasSubst(k))) ctx.add('error', 'enc-current-key', ctx.valueNode(cur), `current_key_id ${textOf(cur).trim()} matches no key ("Not found a key with the current ID").`, refs);
  else if (!cur && ids.size > 1) ctx.add('error', 'enc-current-key', sec, `<${sec.name}> has several keys but no <current_key_id>.`, refs);
  return keys.length;
}

function checkEncryptionCodecs(ctx) {
  const ec = child(ctx.cfg, 'encryption_codecs');
  if (!ec || ctx.hasSubst(ec)) return;
  const refs = [ref.server('encryption_codecs'), ref.source('src/Compression/CompressionCodecEncrypted.cpp', 'CompressionCodecEncrypted.cpp')];
  for (const sec of ec.children) {
    const bytes = { aes_128_gcm_siv: 16, aes_256_gcm_siv: 32 }[sec.name];
    if (!bytes) { unknownChild(ctx, sec, ['aes_128_gcm_siv', 'aes_256_gcm_siv'], refs); continue; }
    if (!checkKeys(ctx, sec, bytes, sec.name, refs) && !ctx.hasSubst(sec)) ctx.add('error', 'enc-no-key', sec, `<${sec.name}> has no <key> or <key_hex> ("No keys, an encryption needs keys to work").`, refs);
    const nonce = child(sec, 'nonce_hex') || child(sec, 'nonce');
    if (nonce && textOf(nonce)) {
      const n = textOf(nonce);
      const len = nonce.name === 'nonce_hex' ? n.length / 2 : new TextEncoder().encode(n).length;
      if (len !== 12) ctx.add('error', 'enc-nonce', ctx.valueNode(nonce), `The nonce must be 12 bytes; this one is ${len}.`, refs);
    }
  }
}

// ------------------------------------------------------------------ logger
function checkLogger(ctx) {
  const lg = child(ctx.cfg, 'logger');
  if (!lg || ctx.hasSubst(lg)) return;
  const dref = ref.server('logger');
  const kids = new Set(['levels', 'formatting', 'syslog', 'errorlog_level', 'flush', 'rotateOnOpen', 'json', 'console_format_level']);
  for (const s of Object.values(ctx.schema.serverWithPath)) if (s.path.startsWith('logger.')) kids.add(s.path.split('.')[1]);
  for (const p of ctx.schema.refPaths.server) if (p.startsWith('logger.')) kids.add(p.split('.')[1]);
  for (const c of lg.children) {
    if (!kids.has(c.name)) { unknownChild(ctx, c, [...kids], [dref]); continue; }
    if (/(^level$|_level$)/.test(c.name) && textOf(c) && !LOGGER_LEVELS.includes(textOf(c).toLowerCase()))
      ctx.add('error', 'log-level', ctx.valueNode(c), `'${textOf(c)}' is not a valid log level; allowed: ${LOGGER_LEVELS.join(', ')}.`, [dref]);
    else if (/(^level$|_level$)/.test(c.name) && textOf(c) && textOf(c) !== textOf(c).toLowerCase())
      ctx.add('info', 'log-level-case', ctx.valueNode(c), `Log level '${textOf(c)}' is usually written in lowercase.`, [dref]);
  }
  // Rotation and purge values are handed to Poco's FileChannel as raw strings and parsed there at startup.
  const rot = child(lg, 'rotation') || child(lg, 'size');
  if (rot && textOf(rot) && !ctx.hasSubst(rot)) {
    const err = rotationError(textOf(rot).trim());
    if (err) ctx.add('error', 'logger-rotation', ctx.valueNode(rot), `<${rot.name}> '${textOf(rot).trim()}' ${err} The server fails to start ("Invalid rotation format").`, [dref, ref.source('base/poco/Foundation/include/Poco/CombinedRotateStrategy.h', 'CombinedRotateStrategy.h')]);
  }
  if (child(lg, 'rotation') && child(lg, 'size')) ctx.add('info', 'logger-size-ignored', child(lg, 'size'), '<size> is ignored because <rotation> is set.', [dref, ref.source('src/Loggers/Loggers.cpp', 'Loggers.cpp')]);
  const cnt = child(lg, 'count');
  if (cnt && textOf(cnt) != null && !ctx.hasSubst(cnt)) {
    const v = textOf(cnt).trim();
    if (/^none$/i.test(v) || v === '') ctx.add('warning', 'logger-count-none', ctx.valueNode(cnt), `<count> '${v || '(empty)'}' disables purging: rotated log files are never deleted.`, [dref]);
    else if (!/^\s*[1-9]\d*/.test(v)) ctx.add('error', 'logger-count', ctx.valueNode(cnt), `<count> '${v}' must start with a positive number; Poco reads leading digits and rejects 0 ("Zero is not valid purge age"), so the server fails to start.`, [dref, ref.source('base/poco/Foundation/src/FileChannel.cpp', 'FileChannel.cpp')]);
    else if (!/^\d+$/.test(v)) ctx.add('warning', 'logger-count-trailing', ctx.valueNode(cnt), `<count> '${v}': only the leading number is used.`, [dref]);
  }
  const lv = child(lg, 'levels');
  if (lv) {
    for (const l of lv.children) {
      if (l.name !== 'logger') continue;
      const lvl = textOf(child(l, 'level'));
      if (!child(l, 'name')) ctx.add('error', 'logger-name', l, '<levels><logger> needs a <name>.', [dref]);
      if (lvl && !LOGGER_LEVELS.includes(lvl.toLowerCase())) ctx.add('error', 'log-level', child(l, 'level'), `'${lvl}' is not a valid log level.`, [dref]);
    }
  }
  if (!child(lg, 'log') && !child(lg, 'console') && ctx.mode !== 'users') ctx.add('info', 'logger-nofile', lg, '<logger> has no <log> file; output goes to the console only when <console> is enabled or the server runs in the foreground.', [dref]);
}

// ------------------------------------------------------------------ misc lints
function checkMisc(ctx) {
  const { cfg, add, schema } = ctx;
  const ratio = child(cfg, 'max_server_memory_usage_to_ram_ratio');
  const rv = ratio && textOf(ratio);
  if (rv && /^[\d.]+$/.test(rv)) {
    const f = Number(rv);
    if (f > 1) add('info', 'mem-ratio', ctx.valueNode(ratio), `max_server_memory_usage_to_ram_ratio = ${f} exceeds 1; only sensible on hosts with low RAM and swap (per the docs).`, [ref.server('max_server_memory_usage_to_ram_ratio')]);
    if (f === 0) add('info', 'mem-ratio0', ctx.valueNode(ratio), 'A ratio of 0 disables the startup cap and runtime adjustment of the memory limit.', [ref.server('max_server_memory_usage_to_ram_ratio')]);
  }
  const incl = [];
  walk(cfg, (n) => { if (n.attrs.has('incl')) incl.push(n); });
  if (incl.length && !child(cfg, 'include_from'))
    add('info', 'incl-no-include-from', incl[0], `'incl' substitutions are used but <include_from> is not set in this file. Since 26.8 there is no implicit /etc/metrika.xml; make sure include_from is set (each separately loaded config file needs its own).`, [ref.configFiles('substitution-with-file-content', 'Substitution with file content')]);
  const envs = [];
  walk(cfg, (n) => { if (n.attrs.has('from_env') || n.attrs.has('from_zk')) envs.push(n); });
  if (envs.length) add('info', 'subst-unchecked', envs[0], `${envs.length} element(s) take their value from from_env/from_zk; those values are not validated here.`, [ref.configFiles('from_env_zk', 'Substitution by environment variables and ZooKeeper nodes')]);

  const lh = childrenNamed(cfg, 'listen_host').map((n) => textOf(n));
  if (lh.includes('::') && lh.includes('0.0.0.0'))
    add('warning', 'listen-both', childrenNamed(cfg, 'listen_host')[1], "Both '::' and '0.0.0.0' are listed; on hosts where '::' also binds IPv4 the second listener fails with 'Address already in use'. Use '::' alone (or '0.0.0.0' if IPv6 is disabled).", [ref.server('listen_host')]);
  const mt = child(cfg, 'merge_tree');
  const rmt = child(cfg, 'replicated_merge_tree');
  for (const sec of [mt, rmt].filter(Boolean)) {
    for (const c of sec.children) {
      if (c.name === 'include') continue;
      const name = schema.mergeTree[c.name] ? c.name : schema.mergeTreeAliases[c.name];
      if (!name) {
        if (removedSetting(ctx, 'mergeTree', c, 'MergeTree setting', 'the server refuses to start (UNKNOWN_SETTING)', [ref.server(sec.name)])) continue;
        const s = suggest(c.name, Object.keys(schema.mergeTree));
        const loc = s ? null : whereValid(ctx, c);
        add('error', 'unknown-mergetree', c, `Unknown MergeTree setting <${c.name}> in <${sec.name}>${s ? `; did you mean <${s.name}>?` : ''}. The server refuses to start (UNKNOWN_SETTING "in MergeTree config").${loc ? loc.msg : ''}`,
          [ref.server(sec.name), ref.source(SRC.mergeTree, 'MergeTreeSettings.cpp (loadFromConfig)'), ...(loc ? loc.refs : [])], { fix: s ? { kind: 'rename', to: s.name } : loc ? { kind: 'move', to: loc.parents } : undefined });
        continue;
      }
      const def = schema.mergeTree[name];
      ctx.recognized.push({ scope: sec.name, name, type: def.t, def: def.d, value: textOf(c) ?? '', line: c.line, file: c.textFile || c.file, url: ref.mergeTree(name).url, desc: def.desc });
      lifecycle(ctx, c, 'MergeTree setting', name, def, ref.mergeTree(name), 'mergetree');
      typeCheck(ctx, c, def.t, {}, [ref.mergeTree(name)]);
    }
  }
  const macros = child(cfg, 'macros');
  if (macros && !ctx.hasSubst(macros)) {
    for (const m of macros.children) {
      if (m.children.length) add('error', 'macro-nested', m, `Macro <${m.name}> must be a plain value.`, [ref.server('macros')]);
      else if (!textOf(m) && !ctx.hasSubst(m)) add('warning', 'macro-empty', m, `Macro <${m.name}> is empty.`, [ref.server('macros')]);
    }
  }
  const tz = child(cfg, 'timezone');
  if (tz && textOf(tz) && !/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$|^UTC$|^Etc\/GMT[+-]\d+$/.test(textOf(tz)))
    add('warning', 'timezone', ctx.valueNode(tz), `'${textOf(tz)}' does not look like an IANA time zone name (e.g. Europe/Moscow, UTC).`, [ref.server('timezone')]);
}
