#!/usr/bin/env node
// Start a real ClickHouse server on a config and report whether it came up, and the first exception if not.
// Used to confirm what a check claims before writing "the server fails to start" (or "verified with …").
//
//   CLICKHOUSE=/path/to/clickhouse node tools/startup.mjs path/to/config.xml [more configs...]
//
// Each config runs in its own temporary directory with <path> pointed there. Ports are left as written, so give
// each test config its own ports. users.xml next to the config is used when present.

import { mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const bin = process.env.CLICKHOUSE;
if (!bin || process.argv.length < 3) {
  console.error('Usage: CLICKHOUSE=/path/to/clickhouse node tools/startup.mjs <config.xml>...');
  process.exit(2);
}

const run = (args, ms) =>
  new Promise((resolve) =>
    execFile('timeout', [String(ms / 1000), ...args], { encoding: 'utf8', maxBuffer: 1e8 }, (e, out, err) =>
      resolve((out || '') + (err || '')),
    ),
  );

for (const config of process.argv.slice(2)) {
  const dir = mkdtempSync(join(tmpdir(), 'ch-startup-'));
  // Point data and logs at the temp dir and log to the console at information level.
  const text = readFileSync(config, 'utf8').replace(
    /<\/clickhouse>\s*$/,
    `<path replace="1">${dir}/data/</path><logger replace="1"><console>1</console><level>information</level></logger></clickhouse>\n`,
  );
  writeFileSync(join(dir, 'config.xml'), text);
  const users = join(dirname(config), 'users.xml');
  if (existsSync(users)) copyFileSync(users, join(dir, 'users.xml'));
  const out = await run([bin, 'server', `--config-file=${join(dir, 'config.xml')}`], 20000);
  const started = /Ready for connections/.test(out);
  const error = (/Code: \d+\. DB::Exception: [^\n]*/.exec(out) || [''])[0].replace(/, Stack trace.*$/, '');
  console.log(`${started ? 'STARTED' : 'FAILED '} ${config}${error ? `\n        ${error}` : ''}`);
  rmSync(dir, { recursive: true, force: true });
}
