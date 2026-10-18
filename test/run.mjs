// Regression tests: node test/run.mjs
import { readFileSync } from 'node:fs';
import { analyze } from '../js/engine.js';
import { parseXml } from '../js/xml.js';
import { parseYaml } from '../js/tree.js';
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

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
