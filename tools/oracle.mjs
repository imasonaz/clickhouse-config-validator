#!/usr/bin/env node
// Differential test against a real ClickHouse binary: for each case in test/oracle/<case>/, start
// `clickhouse server` just long enough to write its preprocessed config, and compare that with the
// merged result of analyzeSet(). Usage: CLICKHOUSE=/path/to/clickhouse node tools/oracle.mjs [case...]

import {
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  cpSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { analyzeSet } from '../js/engine.js';
import { parseXml } from '../js/xml.js';

const CH = process.env.CLICKHOUSE || 'clickhouse';
const root = new URL('../test/oracle/', import.meta.url).pathname;
const schema = JSON.parse(readFileSync(new URL('../data/schema.json', import.meta.url)));
const cases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());

const list = (dir) =>
  readdirSync(dir, { recursive: true })
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
// Structural signature: element names, attributes (minus merge markers), trimmed text, child order.
const sig = (n) => {
  const attrs = [...n.attrs]
    .filter(([k]) => !['replace', 'remove'].includes(k))
    .map(([k, v]) => `${k}=${v.value}`)
    .sort()
    .join(',');
  const kids = n.children.map(sig).join('');
  const text = n.children.length ? '' : (n.text ?? '').trim();
  return `<${n.name}${attrs ? ` ${attrs}` : ''}>${kids || text}</${n.name}>`;
};

async function realPreprocessed(dir, main, env) {
  const data = join(dir, '__data');
  mkdirSync(data, { recursive: true });
  const target = main;
  const args = [
    'server',
    '--config-file',
    main,
    '--',
    `--path=${data}/`,
    '--http_port=0',
    '--tcp_port=0',
    '--listen_host=127.0.0.1',
  ];
  if (main.startsWith('users')) {
    writeFileSync(join(dir, '__main.xml'), `<clickhouse><users_config>${main}</users_config></clickhouse>`);
    args[2] = '__main.xml';
  }
  const p = spawn(CH, args, { cwd: dir, env: { ...process.env, ...env } });
  let log = '';
  p.stdout.on('data', (d) => {
    log += d;
  });
  p.stderr.on('data', (d) => {
    log += d;
  });
  // Written under <path>/preprocessed_configs, or next to the config when the server stops early.
  const outs = [
    join(data, 'preprocessed_configs', target.replace(/\.(ya?ml|conf)$/, '.xml')),
    join(dir, target.replace(/\.(xml|ya?ml|conf)$/, '-preprocessed.xml')),
  ];
  const found = () => outs.find((o) => existsSync(o));
  for (let i = 0; i < 100 && !found(); i++) await new Promise((r) => setTimeout(r, 100));
  const out = found() || outs[0];
  await new Promise((r) => setTimeout(r, 200));
  p.kill('SIGKILL');
  if (!existsSync(out))
    return { error: (log.match(/<Error>.*|DB::Exception.*|Poco::Exception.*/) || [log.slice(-400)])[0] };
  return { xml: readFileSync(out, 'utf8') };
}

let fails = 0;
for (const c of cases) {
  const src = join(root, c);
  const dir = mkdtempSync(join(tmpdir(), `oracle-${c}-`));
  cpSync(src, dir, { recursive: true });
  const env = existsSync(join(dir, 'env'))
    ? Object.fromEntries(
        readFileSync(join(dir, 'env'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
    : {};
  const files = [];
  for (const f of list(dir)) {
    if (f === 'env') continue;
    let text = readFileSync(join(dir, f), 'utf8');
    if (text.includes('INCLUDE_DIR')) {
      writeFileSync(join(dir, f), text.replaceAll('INCLUDE_DIR', dir));
      text = text.replaceAll('INCLUDE_DIR', '/etc/clickhouse-server');
    }
    files.push({ path: f, text });
  }
  const main = files.find((f) => /^(config|users)\.(xml|ya?ml)$/.test(f.path)).path;
  const mine = analyzeSet(files, {
    schema,
    mainPath: main,
    substitutions: Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  });
  const real = await realPreprocessed(dir, main, env);
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
  else console.log(dir);
  if (real.error) {
    console.log(`?? ${c}: server did not preprocess: ${real.error}`);
    fails++;
    continue;
  }
  const drop = (r) => {
    r.children = r.children.filter(
      (n) => !['path', 'http_port', 'tcp_port', 'listen_host', 'include_from'].includes(n.name),
    );
    return r;
  };
  const a = sig(drop(parseXml(real.xml).root))
    .replace(/^<yandex>/, '<clickhouse>')
    .replace(/<\/yandex>$/, '</clickhouse>');
  const b = sig(drop(mine.merged.root))
    .replace(/^<yandex>/, '<clickhouse>')
    .replace(/<\/yandex>$/, '</clickhouse>');
  // Top-level keys overridden on the command line (and include_from, whose path differs) are left out above.
  const strip = (x) => x;
  if (strip(a) === strip(b)) console.log(`ok ${c}`);
  else {
    fails++;
    console.log(`FAIL ${c}\n  clickhouse: ${strip(a)}\n  ours:       ${strip(b)}`);
  }
}
process.exit(fails ? 1 : 0);
