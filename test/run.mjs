// Regression tests: node test/run.mjs
import { readFileSync } from 'node:fs';
import { analyze, analyzeSet, mainCandidates } from '../js/engine.js';
import { parseXml } from '../js/xml.js';
import { parseYaml, getPath } from '../js/tree.js';
import { toXml, toYaml } from '../js/format.js';

const schema = JSON.parse(readFileSync(new URL('../data/schema.json', import.meta.url)));
const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
let failed = 0, passed = 0;
const check = (name, cond, info = '') => {
  if (cond) passed++;
  else { failed++; console.error(`FAIL ${name} ${info}`); }
};
const codes = (res, sev) => res.findings.filter((f) => !sev || f.sev === sev).map((f) => f.code);

// Shipped reference configs must produce no errors or warnings.
for (const f of ['config.xml', 'config.yaml', 'keeper_config.xml', 'users.xml', 'users.yaml']) {
  const res = analyze(fx(f), { schema });
  const bad = res.findings.filter((x) => x.sev === 'error' || (x.sev === 'warning' && x.code !== 'open-user'));
  check(`${f} clean`, bad.length === 0, JSON.stringify(bad.slice(0, 3)));
}

const expect = {
  'bad_server.xml': ['log-level', 'port-dup', 'type', 'trailing-slash', 'case', 'unknown-mergetree', 'syslog-engine', 'replica-host', 'cluster-elem',
    'zk-root', 'zk-lb', 'multi-subst', 'include-no-subst', 'unknown-setting', 'auth-multi', 'sha256-len', 'networks-key', 'unknown-key', 'whitespace',
    'session-at-root', 'user-profile'],
  'bad_keeper.xml': ['election-bounds', 'type', 'unknown-coord', 'feature-flag', 'raft-localhost-mix', 'raft-dup-id', 'raft-missing', 'coord-misplaced', '4lw', 'raft-even'],
  'bad_server.yaml': ['type', 'yaml-explicit-root', 'yaml-dup-key', 'yaml-merge-key'],
  'broken.xml': ['syntax'],
  'broken.yaml': ['syntax'],
};
for (const [f, want] of Object.entries(expect)) {
  const got = new Set(codes(analyze(fx(f), { schema })));
  for (const c of want) check(`${f} reports ${c}`, got.has(c), `got: ${[...got].join(',')}`);
}

// Keeper semantics.
{
  const k = (raft, extra = '') => analyze(`<clickhouse><keeper_server><tcp_port>9181</tcp_port><server_id>1</server_id>${extra}<raft_configuration>${raft}</raft_configuration></keeper_server></clickhouse>`, { schema });
  const srv = (id, h, p = 9234, more = '') => `<server><id>${id}</id><hostname>${h}</hostname><port>${p}</port>${more}</server>`;
  check('keeper ok 3 nodes', codes(k(srv(1, 'a') + srv(2, 'b') + srv(3, 'c'))).filter((c) => c !== 'keeper-log-path' && c !== 'keeper-snap-path').length === 0, codes(k(srv(1, 'a') + srv(2, 'b') + srv(3, 'c'))).join());
  check('keeper self missing', codes(k(srv(2, 'b') + srv(3, 'c'))).includes('raft-self'));
  check('keeper dup endpoint', codes(k(srv(1, 'a') + srv(2, 'a'))).includes('raft-dup-endpoint'));
  check('keeper raft port = tcp_port', codes(k(srv(1, 'a', 9181))).includes('raft-port'));
  check('keeper all followers', codes(k(srv(1, 'a', 9234, '<start_as_follower>true</start_as_follower>'))).includes('raft-followers'));
  check('keeper learner not counted', !codes(k(srv(1, 'a') + srv(2, 'b') + srv(3, 'c') + srv(4, 'd', 9234, '<can_become_leader>false</can_become_leader>'))).includes('raft-even'));
  check('keeper poco bool accepts yes', !codes(k(srv(1, 'a') + srv(2, 'b') + srv(3, 'c'), '<digest_enabled>yes</digest_enabled>')).includes('type'));
}

// Type parsing.
{
  const one = (xml) => codes(analyze(`<clickhouse>${xml}</clickhouse>`, { schema }));
  check('size suffix Gi ok', !one('<mark_cache_size>5Gi</mark_cache_size>').includes('type'));
  check('size suffix lowercase g rejected', one('<mark_cache_size>5g</mark_cache_size>').includes('type'));
  check('negative unsigned rejected', one('<max_thread_pool_size>-1</max_thread_pool_size>').includes('type'));
  check('bool TRUE ok', !one('<shutdown_wait_unfinished_queries>TRUE</shutdown_wait_unfinished_queries>').includes('type'));
  check('nesting in scalar', one('<max_connections><a>1</a></max_connections>').includes('nesting'));
  check('enum server setting', one('<seccomp>strict</seccomp>').includes('type'));
  check('from_env skips type check', !one('<max_connections from_env="X"/>').includes('type'));
  check('yandex root warns', codes(analyze('<yandex><max_connections>1</max_connections></yandex>', { schema })).includes('root-yandex'));
  check('wrong root errors', codes(analyze('<config><max_connections>1</max_connections></config>', { schema })).includes('root-name'));
}

// XML -> YAML -> tree round trip keeps structure and values.
{
  const sig = (n) => `${n.name}[${[...n.attrs].map(([k, v]) => `${k}=${v.value}`).join(',')}]${n.children.length ? `{${n.children.map(sig).join(';')}}` : `=${(n.text ?? '').trim()}`}`;
  for (const f of ['config.xml', 'keeper_config.xml', 'users.xml', 'bad_server.xml']) {
    const doc = parseXml(fx(f));
    const yaml = toYaml(doc.root);
    const back = parseYaml(yaml).root;
    const a = sig(doc.root).replace(/^\w+/, 'clickhouse');
    check(`roundtrip ${f}`, a === sig(back), `\n${a.slice(0, 300)}\n${sig(back).slice(0, 300)}`);
    const again = parseXml(toXml(doc));
    check(`xml reformat ${f}`, sig(again.root) === sig(doc.root));
  }
}

// config.d merging and substitutions.
{
  const set = (files, opts = {}) => analyzeSet(Object.entries(files).map(([path, text]) => ({ path, text })), { schema, ...opts });
  const g = (r, p) => { const n = getPath(r.merged.root, p); return n ? (n.text ?? '').trim() : undefined; };
  const main = '<clickhouse><logger><level>trace</level><size>1000M</size></logger><max_connections>4096</max_connections><path>/var/lib/clickhouse/</path>'
    + '<remote_servers><a><shard><replica><host>h1</host><port>9000</port></replica></shard></a></remote_servers><http_port>8123</http_port></clickhouse>';
  let r = set({ 'config.xml': main,
    'config.d/10-log.xml': '<clickhouse><logger><level>warning</level></logger></clickhouse>',
    'config.d/20-remote.xml': '<clickhouse><remote_servers replace="1"><b><shard><replica><host>h2</host><port>9000</port></replica></shard></b></remote_servers></clickhouse>',
    'config.d/30-rm.yaml': 'http_port:\n  "@remove": 1\nmax_connections: 100\n',
    'config.d/notes.txt': 'ignored', 'config.d/.tmp.xml': '<clickhouse/>' });
  check('merge override', g(r, 'logger.level') === 'warning', g(r, 'logger.level'));
  {
    // Results captured from ClickHouse 26.9 (tools/oracle.mjs): duplicates are matched through a libc++ multimap.
    const hs = (x) => x.merged.root.children.filter((c) => c.name === 'g').map((c) => c.children[0].text).join(',');
    const dup = (n, f) => set({ 'config.xml': `<clickhouse>${Array.from({ length: n }, (_, i) => `<g><h>${i + 1}</h></g>`).join('')}</clickhouse>`,
      'config.d/a.xml': `<clickhouse>${f.map((v) => `<g><h>${v}</h></g>`).join('')}</clickhouse>` });
    check('duplicate match 3+1', hs(dup(3, ['A'])) === '1,A,3', hs(dup(3, ['A'])));
    check('duplicate match 4+2', hs(dup(4, ['A', 'B'])) === '1,A,B,4', hs(dup(4, ['A', 'B'])));
  }
  check('merge keeps untouched', g(r, 'logger.size') === '1000M');
  check('merge replace', !getPath(r.merged.root, 'remote_servers.a') && !!getPath(r.merged.root, 'remote_servers.b'));
  check('merge remove (yaml fragment)', !getPath(r.merged.root, 'http_port'));
  check('merge yaml scalar override', g(r, 'max_connections') === '100');
  check('merge ignores non-config ext', r.plan.find((p) => p.path === 'config.d/notes.txt').role === 'ignored');
  check('merge ignores dotfiles', r.plan.find((p) => p.path === 'config.d/.tmp.xml').role === 'ignored');
  check('merge events', r.events.some((e) => e.type === 'override' && e.target === 'logger.level'));
  check('merged clean', !r.findings.some((f) => f.sev === 'error'), JSON.stringify(r.findings.filter((f) => f.sev === 'error')));

  // Ordering: later files (lexicographic) win.
  r = set({ 'config.xml': main, 'config.d/b.xml': '<clickhouse><max_connections>2</max_connections></clickhouse>', 'config.d/a.xml': '<clickhouse><max_connections>1</max_connections></clickhouse>' });
  check('merge order', g(r, 'max_connections') === '2');

  // Type errors in fragments are attributed to the fragment.
  r = set({ 'config.xml': main, 'config.d/x.xml': '<clickhouse>\n<max_connections>lots</max_connections></clickhouse>' });
  const te = r.findings.find((f) => f.code === 'type');
  check('fragment error attributed', te && te.file === 'config.d/x.xml' && te.line === 2, JSON.stringify(te));

  r = set({ 'config.xml': main, 'config.d/x.xml': '<clickhouse><logger remove="1" replace="1"/></clickhouse>' });
  check('remove+replace error', r.findings.some((f) => f.code === 'replace-remove' && f.sev === 'error'));
  r = set({ 'config.xml': main, 'config.d/x.xml': '<other><a>1</a></other>' });
  check('root mismatch', r.findings.some((f) => f.code === 'merge-root'));
  r = set({ 'config.xml': main, 'config.d/x.xml': '<yandex><max_connections>7</max_connections></yandex>' });
  check('yandex root merges', g(r, 'max_connections') === '7');

  // Substitutions.
  const sub = '<clickhouse><include_from>/etc/clickhouse-server/metrika.xml</include_from><max_connections from_env="MAXC"/><zookeeper incl="zookeeper-servers"/>'
    + '<macros><replica from_env="REPLICA" replace="1">r0</replica></macros><listen_host from_env="LH" optional="1"/><http_port from_zk="/cfg/http"/></clickhouse>';
  r = set({ 'config.xml': sub, 'metrika.xml': '<clickhouse><zookeeper-servers><node><host>zk1</host><port>2181</port></node></zookeeper-servers></clickhouse>' },
    { substitutions: 'MAXC=abc\nREPLICA=r9\n/cfg/http=8124' });
  check('incl resolved', getPath(r.merged.root, 'zookeeper.node.host')?.text === 'zk1');
  check('from_env value validated', r.findings.some((f) => f.code === 'type' && /max_connections/.test(f.msg)), codes(r).join(','));
  check('from_env replace default', g(r, 'macros.replica') === 'r9');
  check('optional missing removed', !getPath(r.merged.root, 'listen_host'));
  check('from_zk text', g(r, 'http_port') === '8124');
  check('include file role', r.plan.find((p) => p.path === 'metrika.xml').role === 'include');
  r = set({ 'config.xml': sub });
  check('missing env reported', r.findings.some((f) => f.code === 'subst-missing' && /MAXC/.test(f.msg)));
  check('missing include_from file', r.findings.some((f) => f.code === 'include-from-missing'));
  check('subst-has-value', codes(analyze('<clickhouse><max_connections from_env="X">5</max_connections></clickhouse>', { schema })).includes('subst-has-value'));

  // users.d with users.xml as main; profile defined in fragment is found.
  r = set({ 'users.xml': '<clickhouse><users><default><password></password><profile>p2</profile><networks><ip>::/0</ip></networks></default></users><profiles><default/></profiles></clickhouse>',
    'users.d/p.xml': '<clickhouse><profiles><p2><max_threads>4</max_threads></p2></profiles></clickhouse>' });
  check('users.d merge resolves profile', !r.findings.some((f) => f.code === 'user-profile'), codes(r).join(','));
  check('main candidates', JSON.stringify(mainCandidates([{ path: 'config.d/a.xml' }, { path: 'users.xml' }, { path: 'config.xml' }])) === '["config.xml","users.xml"]');
}

// Unknown keys suggest valid locations.
{
  const f = analyze('<clickhouse><keeper_server><listen_host>::</listen_host><tcp_port>9181</tcp_port><server_id>1</server_id></keeper_server></clickhouse>', { schema }).findings.find((x) => x.code === 'unknown-key');
  check('unknown key location', f && f.fix?.kind === 'move' && f.fix.to.includes('') && /top level/.test(f.msg), JSON.stringify(f));
  const m = analyze('<clickhouse><merge_tree><max_threads>3</max_threads></merge_tree></clickhouse>', { schema }).findings.find((x) => x.code === 'unknown-mergetree');
  check('mergetree location', m && /profile/.test(m.msg));
}

// Host / IP address syntax.
{
  const bad = (v, key = 'listen_host') => codes(analyze(`<clickhouse><${key}>${v}</${key}></clickhouse>`, { schema })).includes('bad-address');
  for (const v of ['0.0.0', '256.0.0.1', '1.2.3.4.5', '01.2.3.4', '1::2::3', '10.0.0.1:9000', 'bad host']) check(`bad address ${v}`, bad(v));
  for (const v of ['0.0.0.0', '::', '::1', '127.0.0.1', 'fe80::1%eth0', '::ffff:10.0.0.1', 'localhost', 'ch-1.example.com']) check(`good address ${v}`, !bad(v));
  check('interserver host checked', bad('ch 1', 'interserver_http_host'));
}

// Setting lifecycle: obsolete, feature tiers, target version.
{
  const pick = (pred) => Object.entries(schema.session).find(([, v]) => pred(v))[0];
  const exp = pick((v) => v.tier === 'experimental' && !v.obsolete);
  const beta = pick((v) => v.tier === 'beta' && !v.obsolete);
  const obs = pick((v) => v.obsolete && v.h && v.h.some((r) => /obsolete/i.test(r[3])));
  const fresh = pick((v) => !v.tier && !v.obsolete && v.h && /new setting/i.test(v.h.at(-1)[3]) && v.h.at(-1)[0] === '26.8');
  const prof = (body, extra = '') => `<clickhouse>${extra}<profiles><default>${body}</default></profiles></clickhouse>`;
  const tag = (n, v = '1') => `<${n}>${v}</${n}>`;
  check('experimental flagged', codes(analyze(prof(tag(exp)), { schema })).includes('tier-experimental'));
  check('beta noted', codes(analyze(prof(tag(beta)), { schema }), 'info').includes('tier-beta'));
  check('allow_feature_tier blocks', codes(analyze(prof(tag(exp), '<allow_feature_tier>1</allow_feature_tier>'), { schema })).includes('tier-blocked'));
  check('allow_feature_tier 1 allows beta', !codes(analyze(prof(tag(beta), '<allow_feature_tier>1</allow_feature_tier>'), { schema })).includes('tier-blocked'));
  check('obsolete warned', codes(analyze(prof(tag(obs, schema.session[obs].d)), { schema }), 'warning').includes('obsolete'));
  check('too new for target', codes(analyze(prof(tag(fresh, schema.session[fresh].d)), { schema, version: '26.3' })).includes('version-too-new'));
  check('fine on latest', !codes(analyze(prof(tag(fresh, schema.session[fresh].d)), { schema })).includes('version-too-new'));
  check('digit separators parsed', !!schema.session.allow_experimental_usearch_index);
  // Per-release index (tools/releases.py).
  check('release list', schema.releases[0] === '24.1' && schema.releases.includes('26.8'));
  check('since from release index', codes(analyze('<clickhouse><merge_tree><apply_patches_on_merge>1</apply_patches_on_merge></merge_tree></clickhouse>', { schema, version: '25.3' })).includes('version-too-new'));
  check('coordination since', codes(analyze('<clickhouse><keeper_server><server_id>1</server_id><coordination_settings><use_new_dispatcher>1</use_new_dispatcher></coordination_settings></keeper_server></clickhouse>', { schema, mode: 'keeper', version: '26.3' })).includes('version-too-new'));
  const ice = tag('allow_experimental_time_series_aggregate_functions');
  check('removed setting still valid on old target', codes(analyze(prof(ice), { schema, version: '26.3' }), 'info').includes('removed-later') && !codes(analyze(prof(ice), { schema, version: '26.3' })).includes('unknown-setting'));
  check('removed setting on latest', codes(analyze(prof(ice), { schema }), 'error').includes('removed-setting'));
  check('removed server key warns', codes(analyze('<clickhouse><dns_cache_max_size>1</dns_cache_max_size></clickhouse>', { schema }), 'warning').includes('removed-setting'));
}

// Share links: redaction and round trip.
{
  const { redact, shareableState, encodeState, decodeState } = await import('../js/share.js');
  const x = redact(fx('users.xml').replace('<password></password>', '<password>hunter2</password>'));
  check('redacts password', !x.text.includes('hunter2') && x.count >= 1);
  const y = redact('users:\n  u:\n    password_sha256_hex: "65e84be33532fb784c48129675f9eff3a682b27168c0ea744b2cf58ee02337c5"\n');
  check('hex keeps length', /"0{64}"/.test(y.text));
  const { state: st, redacted } = shareableState({ files: [{ path: 'users.xml', text: '<clickhouse><users><a><password>p</password></a></users></clickhouse>' }], subst: 'DB_PASSWORD=x\nN=1', version: '25.8', view: 'merged', mainPath: '', active: 0 });
  check('share redaction count', redacted === 2, String(redacted));
  const back = await decodeState(await encodeState(st));
  check('share round trip', back.files[0].text.includes('REDACTED') && back.subst === 'DB_PASSWORD=REDACTED\nN=1' && back.version === '25.8');
}

// Keeper ensemble cross-check.
{
  const k = (id, raft, extra = '') => `<clickhouse><keeper_server><tcp_port>9181</tcp_port><server_id>${id}</server_id><log_storage_path>/a/</log_storage_path><snapshot_storage_path>/b/</snapshot_storage_path><coordination_settings>${extra}</coordination_settings><raft_configuration>${raft}</raft_configuration></keeper_server></clickhouse>`;
  const R = (l) => l.map(([i, h, p]) => `<server><id>${i}</id><hostname>${h}</hostname><port>${p}</port></server>`).join('');
  const full = [[1, 'k1', 9234], [2, 'k2', 9234], [3, 'k3', 9234]];
  const set = (fs) => analyzeSet(fs.map(([path, text]) => ({ path, text })), { schema });
  let r = set([['keeper1.xml', k(1, R(full))], ['keeper2.xml', k(2, R(full))], ['keeper3.xml', k(3, R(full))]]);
  check('ensemble clean', r.cross.length === 0, JSON.stringify(r.cross));
  r = set([['keeper1.xml', k(1, R(full))], ['keeper2.xml', k(1, R([[1, 'k1', 9234], [2, 'k2', 9999], [3, 'k3', 9234]]), '<election_timeout_lower_bound_ms>500</election_timeout_lower_bound_ms>')]]);
  const cc = r.cross.map((f) => f.code);
  for (const c of ['ensemble-dup-id', 'ensemble-raft-diff', 'ensemble-coord-diff', 'ensemble-partial']) check(`ensemble ${c}`, cc.includes(c), cc.join(','));
  r = set([['config.xml', '<clickhouse><zookeeper><node><host>k1</host><port>9234</port></node></zookeeper></clickhouse>'], ['keeper1.xml', k(1, R(full))]]);
  check('zk points at raft port', r.cross.some((f) => f.code === 'zk-raft-port' && f.file === 'config.xml'));
  check('loose keeper file is separate', r.plan.find((p) => p.path === 'keeper1.xml').role === 'separate');
}

// Logger rotation, object storage disks, encryption keys.
{
  const lg = (inner) => codes(analyze(`<clickhouse><logger><log>/x.log</log>${inner}</logger></clickhouse>`, { schema }));
  for (const v of ['100M', '1G', '1000000', 'daily', '100M,daily', '10 minutes', '12:00', 'never', '100 M']) check(`rotation ok ${v}`, !lg(`<size>${v}</size>`).includes('logger-rotation'));
  for (const v of ['1GB', '100m', '10Mi', 'big', '0']) check(`rotation bad ${v}`, lg(`<size>${v}</size>`).includes('logger-rotation'));
  check('count 0', lg('<count>0</count>').includes('logger-count'));
  check('count none', lg('<count>none</count>').includes('logger-count-none'));
  const st = (disk) => codes(analyze(`<clickhouse><storage_configuration><disks>${disk}</disks></storage_configuration></clickhouse>`, { schema }));
  check('s3 no endpoint', st('<d><type>s3</type></d>').includes('s3-endpoint'));
  check('s3 half creds', st('<d><type>s3</type><endpoint>https://b.s3.amazonaws.com/r/</endpoint><secret_access_key>x</secret_access_key></d>').includes('s3-creds'));
  check('s3 ok', !st('<d><type>s3</type><endpoint>https://b.s3.amazonaws.com/r/</endpoint><access_key_id>a</access_key_id><secret_access_key>x</secret_access_key></d>').some((c) => c.startsWith('s3-')));
  check('encrypted disk key size', st('<e><type>encrypted</type><disk>default</disk><algorithm>aes_256_ctr</algorithm><key>0123456789abcdef</key></e>').includes('enc-key-size'));
  check('encrypted disk ok', !st('<e><type>encrypted</type><disk>default</disk><key>0123456789abcdef</key></e>').some((c) => c.startsWith('enc-')));
  const ec = (inner) => codes(analyze(`<clickhouse><encryption_codecs>${inner}</encryption_codecs></clickhouse>`, { schema }));
  check('codec ok', !ec('<aes_128_gcm_siv><key_hex>00112233445566778899aabbccddeeff</key_hex></aes_128_gcm_siv>').some((c) => c.startsWith('enc-')));
  check('codec multi key needs current', ec('<aes_128_gcm_siv><key_hex id="1">00112233445566778899aabbccddeeff</key_hex><key_hex id="2">00112233445566778899aabbccddeeff</key_hex></aes_128_gcm_siv>').includes('enc-current-key'));
  check('codec nonce', ec('<aes_256_gcm_siv><key>0123456789abcdef0123456789abcdef</key><nonce>short</nonce></aes_256_gcm_siv>').includes('enc-nonce'));
}

// Editor assistance.
{
  const { contextPath, complete, lookup } = await import('../js/assist.js');
  const x = '<clickhouse>\n  <logger>\n    <le';
  check('xml context', JSON.stringify(contextPath(x, x.length, 'xml')) === '["logger"]');
  check('xml context closes', JSON.stringify(contextPath('<clickhouse><logger><level>x</level></logger><', 46, 'xml')) === '[]');
  check('yaml context', JSON.stringify(contextPath('profiles:\n  default:\n    max_', 30, 'yaml')) === '["profiles","default"]');
  check('complete profile', complete(schema, ['profiles', 'default'], 'max_thr')[0] === 'max_threads');
  check('complete coordination', complete(schema, ['keeper_server', 'coordination_settings'], 'heart')[0] === 'heart_beat_interval_ms');
  check('lookup server', lookup(schema, [], 'max_connections')?.scope === 'server setting');
  check('lookup with path', lookup(schema, ['query_cache'], 'max_size_in_bytes')?.name === 'query_cache.max_size_in_bytes');
}

// Move quick fix.
{
  const { moveElement } = await import('../js/fix.js');
  const x = '<clickhouse>\n    <keeper_server>\n        <tcp_port>9181</tcp_port>\n        <force_sync>false</force_sync>\n    </keeper_server>\n</clickhouse>\n';
  const mx = moveElement(x, 'xml', 4, 'force_sync', 'keeper_server.coordination_settings');
  check('move xml creates section', mx === '<clickhouse>\n    <keeper_server>\n        <tcp_port>9181</tcp_port>\n        <coordination_settings>\n            <force_sync>false</force_sync>\n        </coordination_settings>\n    </keeper_server>\n</clickhouse>\n', mx);
  const r = analyze(mx, { schema, mode: 'keeper' });
  check('moved setting recognised', !codes(r).includes('unknown-key'), codes(r).join());
  check('move xml no-op refused', moveElement(x, 'xml', 4, 'force_sync', 'keeper_server') === null);
  const y = 'keeper_server:\n  tcp_port: 9181\n  force_sync: false\n  coordination_settings:\n    operation_timeout_ms: 10000\n';
  check('move yaml into existing section', moveElement(y, 'yaml', 3, 'force_sync', 'keeper_server.coordination_settings') === 'keeper_server:\n  tcp_port: 9181\n  coordination_settings:\n    operation_timeout_ms: 10000\n    force_sync: false\n');
  const mtOnly = Object.keys(schema.mergeTree).find((k) => !schema.session[k] && !schema.server[k] && !schema.coordination[k]);
  const at = analyze(`<clickhouse><${mtOnly}>1</${mtOnly}></clickhouse>`, { schema });
  check('mergetree-at-root offers move', at.findings.some((f) => f.code === 'mergetree-at-root' && f.fix?.kind === 'move'));
}

// Hard-wrapped paste.
{
  const { findWrappedLines, unwrapLines } = await import('../js/fix.js');
  const w = fx('wrapped_keeper.xml');
  check('hard wrap found', findWrappedLines(w).join() === '5,14,16', findWrappedLines(w).join());
  const r0 = analyze(w, { schema });
  check('hard wrap finding on parse error', r0.findings[0].code === 'hard-wrap' && r0.findings[0].fix.kind === 'unwrap');
  const r1 = analyze(unwrapLines(w), { schema });
  check('unwrapped parses', !r1.parseError && !codes(r1).includes('hard-wrap'), codes(r1).join());
  check('multi-line SQL not treated as wrap', !findWrappedLines('<query>SELECT 1\nFROM t</query>\n<x>' + 'y'.repeat(60) + '</x>').length);
  check('clean files have no wraps', ['config.xml', 'keeper_config.xml', 'users.xml', 'bad_server.xml'].every((f) => !findWrappedLines(fx(f)).length));
}

// Syntax colouring must reproduce the text exactly.
{
  const { highlight } = await import('../js/highlight.js');
  const plain = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const cases = [['xml', fx('config.xml')], ['yaml', fx('config.yaml')], ['yaml', fx('bad_server.yaml')], ['xml', fx('broken.xml')], ['xml', '<a x="1" incl="y"><!-- c\n --><![CDATA[<z>]]></a><b'], ['xml', '<a>1 & 2 < 3</a'],
    ['yaml', 'a: 1 # c\nb: "x # y"\n- k: |\n    l1 # not\n    l2\nc: [1, 2]\n"@remove": 1\n']];
  for (const [f, t] of cases) check(`highlight round-trip ${f}`, plain(highlight(t, f)) === t, t.slice(0, 40));
  check('highlight yaml block scalar plain', !highlight('k: |\n  # x\n', 'yaml').includes('hl-com'));
  check('highlight xml subst attr', highlight('<a from_env="X"/>', 'xml').includes('hl-kw'));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
