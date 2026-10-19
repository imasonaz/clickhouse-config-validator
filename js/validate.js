// Validation and linting rules for ClickHouse server and Keeper configuration trees.

import { pathOf, child, textOf, walk, getPath } from './tree.js';
import { ref, SRC } from './docs.js';
import { suggest } from './types.js';
import { CONTEXT_ATTRS, PREPROCESSOR_ATTRS, SERVER_ONLY_HINTS, SUBST_ATTRS } from './checks/constants.js';
import { checkMisc, checkRoot } from './checks/server.js';
import { checkKeeper } from './checks/keeper.js';
import { checkHosts, checkListen, checkPorts } from './checks/network.js';
import { checkUsersFile } from './checks/users.js';
import { checkRemoteServers, checkZookeeper } from './checks/cluster.js';
import { checkEncryptionCodecs, checkStorage } from './checks/storage.js';
import { checkLogger, checkSystemLogs } from './checks/logs.js';
import { checkRefs } from './checks/refs.js';

export { KEEPER_KEYS, USER_KEYS, SYSTEM_LOGS } from './checks/constants.js';
export { locationIndex } from './checks/helpers.js';

/** Guess what kind of config a tree is: 'keeper', 'users' or 'server', from the sections it contains. */
export function detectMode(root) {
  const names = new Set(root.children.map((c) => c.name));
  const hasKeeper = names.has('keeper_server');
  const serverHints = SERVER_ONLY_HINTS.filter((k) => names.has(k)).length;
  if (hasKeeper && serverHints === 0) return 'keeper';
  if (
    !hasKeeper &&
    (names.has('profiles') || names.has('users') || names.has('quotas')) &&
    serverHints <= 3 &&
    [...names].every((n) =>
      [
        'profiles',
        'users',
        'quotas',
        'roles',
        'include_from',
        'settings_profiles',
        'custom_settings_prefixes',
      ].includes(n),
    )
  )
    return 'users';
  return 'server';
}

/**
 * Run every check on one parsed (or merged) document.
 * @param {object} doc { root, warnings, meta } from parseXml / parseYaml, or a merged document (format 'merged')
 * @param {object} opts schema, mode ('auto' | 'server' | 'users' | 'keeper'), format, version, featureTier
 * @returns {{ findings: object[], mode: string, recognized: object[] }} findings sorted by severity then line;
 *   recognized is one row per known setting (for the Settings tab)
 */
export function validate(doc, { schema, mode = 'auto', format = 'xml', version = 'latest', featureTier = null } = {}) {
  const findings = [];
  const recognized = []; // settings we recognised (for the overview table)
  const root = doc.root;
  const effectiveMode = mode === 'auto' ? detectMode(root) : mode;

  // When a YAML file has an explicit `clickhouse:` key we validate its contents as the root.
  const cfg = format !== 'xml' && doc.meta && doc.meta.explicitClickhouseRoot ? doc.meta.explicitClickhouseRoot : root;
  const relPath = (n) => {
    const p = pathOf(n);
    return cfg === root ? p : p.slice(1);
  };
  const add = (sev, code, node, msg, refs = [], extra = {}) => {
    findings.push({
      sev,
      code,
      refs,
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
      add('warning', 'root-yandex', root, 'Root element <yandex> is the legacy name; use <clickhouse>.', [
        ref.configFiles(null, 'Configuration files: top-level tag'),
      ]);
    } else if (root.name !== 'clickhouse') {
      add(
        'error',
        'root-name',
        root,
        `Root element is <${root.name}>; configuration files must use <clickhouse> as the top-level tag. Files in config.d/ with a different root fail to merge ("Root element doesn't have the corresponding root element as the config file").`,
        [
          ref.configFiles(null, 'Configuration files: top-level tag'),
          ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (mergeRecursive)'),
        ],
      );
    }
  } else if (doc.meta) {
    const m = doc.meta;
    if (m.explicitClickhouseRoot) {
      add(
        'error',
        'yaml-explicit-root',
        m.explicitClickhouseRoot,
        `Top-level "${m.explicitClickhouseRoot.name}:" key. YAMLParser always wraps the document in a <clickhouse> element, so this key produces <clickhouse><${m.explicitClickhouseRoot.name}>… and every setting below it is ignored (verified with ClickHouse 26.9: http_port under it is not read). Remove the key and de-indent its contents. The rest of this report validates the contents as if the key were absent.`,
        [
          ref.source(SRC.yamlParser, 'YAMLParser.cpp (buildXMLFromYAMLNode)'),
          ref.configFiles(null, 'Configuration files'),
          ref.configFiles('implementation-details', 'Preprocessed files'),
        ],
      );
    }
    for (const d of m.duplicateKeys)
      add(
        'warning',
        'yaml-dup-key',
        null,
        `Duplicate key '${d.key}' (first defined on line ${d.first}). Both copies become separate elements; ClickHouse reads only the first for a scalar setting. Use a YAML sequence if repetition is intended.`,
        [ref.configFiles('example-1', 'YAML examples')],
        { line: d.line, col: d.col },
      );
    for (const mk of m.mergeKeys)
      add(
        'warning',
        'yaml-merge-key',
        null,
        "YAML merge key '<<' is not converted by ClickHouse's YAMLParser; it becomes an element literally named '<<'. Repeat the keys instead.",
        [ref.source(SRC.yamlParser, 'YAMLParser.cpp')],
        mk,
      );
    for (const nk of m.nonStringKeys)
      add(
        'error',
        'yaml-complex-key',
        null,
        'Complex (non-scalar) YAML keys cannot be represented as XML element names.',
        [ref.source(SRC.yamlParser, 'YAMLParser.cpp')],
        nk,
      );
  }

  // ---------------------------------------------------------------- generic per-node checks
  walk(cfg, (n) => {
    if (n === cfg) return;
    const ctxAttrs = CONTEXT_ATTRS[n.name] || [];
    for (const [a, info] of n.attrs) {
      if (!PREPROCESSOR_ATTRS.has(a) && !ctxAttrs.includes(a)) {
        const s = suggest(a, [...PREPROCESSOR_ATTRS]);
        add(
          s ? 'warning' : 'info',
          'unknown-attr',
          n,
          `Attribute '${a}' is not a ClickHouse preprocessing attribute${s ? `; did you mean '${s.name}'?` : ' and is usually ignored.'}`,
          [ref.configFiles('merging', 'Merging configuration'), ref.configFiles('from_env_zk', 'Substitutions')],
          { line: info.line, col: info.col },
        );
      }
    }
    const substs = SUBST_ATTRS.filter((a) => n.attrs.has(a));
    if (substs.length > 1)
      add(
        'error',
        'multi-subst',
        n,
        `More than one substitution attribute (${substs.join(', ')}) on <${n.name}>; only one is allowed.`,
        [ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (doIncludesRecursive)')],
      );
    for (const a of ['from_env', 'from_zk']) {
      if (n.attrs.has(a) && !n.attrs.has('replace') && (n.children.length || (n.text && n.text.trim())))
        add(
          'error',
          'subst-has-value',
          n,
          `<${n.name}> has a value and '${a}' but no 'replace' attribute; ClickHouse fails with "has value and does not have 'replace' attribute, can't process ${a} substitution". Add replace="1" to use the value as a default.`,
          [
            ref.configFiles('default-values', 'Substitution default values'),
            ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (doIncludesRecursive)'),
          ],
        );
    }
    if (n.attrs.has('yaml')) {
      if (n.name !== 'include' || !n.attrs.has('from_zk'))
        add('error', 'yaml-attr', n, "Attribute 'yaml' is allowed only on <include from_zk=...>.", [
          ref.source(SRC.configProcessor, 'ConfigProcessor.cpp'),
        ]);
      else if (n.attrs.get('yaml').value !== 'true')
        add('error', 'yaml-attr', n, "Attribute 'yaml' for <include from_zk=...> must be 'true'.", [
          ref.source(SRC.configProcessor, 'ConfigProcessor.cpp'),
        ]);
    }
    if (n.name === 'include') {
      if (n.children.length || (n.text && n.text.trim()))
        add('error', 'include-children', n, '<include> element must have no children.', [
          ref.source(SRC.configProcessor, 'ConfigProcessor.cpp'),
        ]);
      if (!substs.length)
        add(
          'error',
          'include-no-subst',
          n,
          '<include> has no substitution attribute (incl, from_zk or from_env); exactly one is required.',
          [
            ref.configFiles('substitution-with-file-content', 'Substitution with file content'),
            ref.source(SRC.configProcessor, 'ConfigProcessor.cpp'),
          ],
        );
    }
    if (n.attrs.has('replace') && n.attrs.has('remove'))
      add(
        'error',
        'replace-remove',
        n,
        `<${n.name}> has both 'replace' and 'remove'; ClickHouse throws "both remove and replace attributes set for element" while merging.`,
        [
          ref.configFiles('merging', 'Merging configuration'),
          ref.source(SRC.configProcessor, 'ConfigProcessor.cpp (mergeRecursive)'),
        ],
      );
    if (
      n.attrs.has('replace') &&
      substs.length &&
      n.attrs.get('replace').line > n.attrs.get(substs[0]).line &&
      format === 'xml'
    )
      add(
        'info',
        'replace-order',
        n,
        `For a default value with ${substs[0]}, the docs say 'replace' must appear before '${substs[0]}'.`,
        [ref.configFiles('default-values', 'Substitution default values')],
      );
    if (n.mixedText)
      add(
        'warning',
        'mixed-content',
        n,
        `<${n.name}> mixes text ('${n.mixedText.text.slice(0, 40)}') with child elements; the text is ignored.`,
        [],
        { line: n.mixedText.line },
      );
    if (n.name.includes('.'))
      add(
        'warning',
        'dotted-name',
        n,
        `Element name '${n.name}' contains '.', which Poco uses as the path separator; ClickHouse cannot address it as one key.`,
        [ref.source(SRC.cluster, 'Cluster.cpp (dots not supported in cluster names)')],
      );
    if (format !== 'xml' && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(n.name) && n.name !== '<<')
      add(
        'warning',
        'bad-name',
        n,
        `'${n.name}' is not a valid XML element name; ClickHouse converts YAML keys to XML elements.`,
        [ref.configFiles('example-1', 'YAML examples')],
      );
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
      add(
        'warning',
        'duplicate-element',
        arr[1],
        `<${k}> appears ${arr.length} times under <${n.name}>. ClickHouse reads only the first (line ${arr[0].line}); later copies are reachable only as ${k}[1], ${k}[2]… by code that iterates over them.`,
        [ref.configFiles('merging', 'Merging configuration')],
      );
    }
  });

  // allow_feature_tier: from this document, or passed in (e.g. from the server config when checking users.xml).
  const aft = getPath(cfg, 'allow_feature_tier');
  const tierLimit = aft && /^\d+$/.test(textOf(aft) || '') ? Number(textOf(aft)) : featureTier;
  const ctx = {
    schema,
    add,
    findings,
    recognized,
    mode: effectiveMode,
    cfg,
    relPath,
    hasSubst,
    valueNode,
    format,
    root,
    version,
    tierLimit,
  };

  // ---------------------------------------------------------------- section checks
  checkRoot(ctx);
  const ks = child(cfg, 'keeper_server');
  if (ks) checkKeeper(ctx, ks);
  else if (effectiveMode === 'keeper')
    add('error', 'keeper-missing', cfg, 'No <keeper_server> section: a Keeper configuration needs one.', [
      ref.keeper(),
    ]);
  if (ks && effectiveMode === 'server')
    add(
      'info',
      'embedded-keeper',
      ks,
      'This server config contains <keeper_server>, so ClickHouse runs an embedded Keeper. Validated with the Keeper rules.',
      [ref.keeper('configuration', 'Keeper configuration')],
    );
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
  checkRefs(ctx);
  checkListen(ctx);

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.sev] - order[b.sev] || a.line - b.line);
  return { findings, mode: effectiveMode, recognized };
}

// Elements that are legitimately repeated.
function isRepeatable(p) {
  const s = p.join('.');
  const last = p[p.length - 1];
  return (
    /^(listen_host|interserver_listen_host)$/.test(s) ||
    [
      'node',
      'shard',
      'replica',
      'server',
      'ip',
      'host',
      'host_regexp',
      'disk',
      'rule',
      'case',
      'include',
      'interval',
      'grants',
      'query',
      'pattern',
      'retention',
      'regexp',
      'prefix',
      'level',
      'logger',
      'ssh_key',
      'common_name',
      'subject_alt_name',
      'database',
      'dictionary',
      'key',
      'access_key_id',
      'header',
      'url',
      'path',
      'role',
      'name',
    ].includes(last) ||
    s.startsWith('remote_url_allow_hosts') ||
    s.startsWith('custom_settings_prefixes') ||
    s.startsWith('url_scheme_mappers') ||
    s.startsWith('kafka') ||
    s.startsWith('named_collections') ||
    s.startsWith('http_handlers') ||
    s.startsWith('proxy') ||
    s.startsWith('dictionaries_config') ||
    s.startsWith('user_defined_executable_functions_config') ||
    s.startsWith('graphite_rollup')
  );
}
