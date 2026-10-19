#!/usr/bin/env node
// Command-line / CI front end: node bin/ch-config-check.mjs [options] <file or directory>...
//
// Directories are read the way ClickHouse reads /etc/clickhouse-server: the main file plus config.d/ (or users.d/)
// fragments, merged, with substitutions applied. Exit code 1 when any finding is at or above --fail-on.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { analyzeSet, mainCandidates } from '../js/engine.js';
import { toText, toMarkdown, toJson, toGithub } from '../js/report.js';
import { upgradeReport, upgradeMarkdown } from '../js/upgrade.js';

const HELP = `Usage: ch-config-check [options] <file or directory>...

Options:
  --main <path>         check only this main file (default: every main file found, e.g. config.xml and users.xml,
                        each with its .d directory)
  --mode <m>            auto | server | users | keeper (default auto)
  --version <v>         target ClickHouse version, e.g. 25.8 (default: latest)
  --env                 resolve from_env from this process's environment
  --subst <file>        substitutions file: NAME=value lines, /zk/path=value for from_zk
  --format <f>          text | markdown | json | github (default text; github emits workflow annotations)
  --fail-on <sev>       error | warning | info | never (default error)
  --upgrade <from:to>   upgrade report instead of a check, e.g. 24.8:26.9 (to may be "latest"): findings that
                        are new at <to>, and default/tier changes in between. Markdown, or JSON with --format json.
                        --fail-on then applies to the new findings only.
  -h, --help`;

const args = process.argv.slice(2);
const opt = { mode: 'auto', version: 'latest', format: 'text', failOn: 'error', paths: [], env: false, allMains: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => { if (i + 1 >= args.length) die(`${a} needs a value`); return args[++i]; };
  if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  else if (a === '--main') opt.main = val();
  else if (a === '--mode') opt.mode = val();
  else if (a === '--version') opt.version = val();
  else if (a === '--env') opt.env = true;
  else if (a === '--subst') opt.subst = val();
  else if (a === '--format') opt.format = val();
  else if (a === '--fail-on') opt.failOn = val();
  else if (a === '--upgrade') opt.upgrade = val();
  else if (a.startsWith('-')) die(`unknown option ${a}\n\n${HELP}`);
  else opt.paths.push(a);
}
if (!opt.paths.length) die(HELP);
function die(msg) { console.error(msg); process.exit(2); }

const schema = JSON.parse(readFileSync(new URL('../data/schema.json', import.meta.url)));
const files = [];
const walk = (dir, root) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (relative(root, p).split('/').length <= 2) walk(p, root); }
    else if (/\.(xml|ya?ml|conf)$/i.test(name)) files.push({ path: relative(root, p), shown: p, text: readFileSync(p, 'utf8') });
  }
};
for (const p of opt.paths) {
  if (!existsSync(p)) die(`${p}: no such file or directory`);
  if (statSync(p).isDirectory()) walk(p, p);
  else files.push({ path: opt.paths.length === 1 ? basename(p) : p, shown: p, text: readFileSync(p, 'utf8') });
}
if (!files.length) die('no .xml, .yaml, .yml or .conf files found');

let subst = opt.subst ? readFileSync(opt.subst, 'utf8') : '';
if (opt.env) {
  const names = new Set([...files.map((f) => f.text).join('\n').matchAll(/from_env\s*[=:]\s*["']?([A-Za-z_][\w]*)/g)].map((m) => m[1]));
  subst += '\n' + [...names].filter((n) => n in process.env).map((n) => `${n}=${process.env[n]}`).join('\n');
}

if (opt.upgrade) {
  const [from, to] = opt.upgrade.split(':');
  if (!from || !to) die('--upgrade needs FROM:TO, e.g. 24.8:26.9');
  const mains = opt.main ? [opt.main] : mainCandidates(files);
  const consumed = new Set();
  const reports = [];
  for (const m of mains) {
    if (consumed.has(m)) continue;
    const plan = analyzeSet(files, { schema, mode: opt.mode, mainPath: m, substitutions: subst }).plan;
    for (const p of plan) if (p.role === 'fragment' || p.role === 'include' || p.role === 'main') consumed.add(p.path);
    reports.push({ main: m, ...upgradeReport(files, { schema, from, to, mode: opt.mode, mainPath: m, substitutions: subst }) });
  }
  const err = reports.find((r) => r.error);
  if (err) die(`${err.main}: ${err.error}`);
  if (opt.format === 'json') console.log(JSON.stringify(reports.map(({ main, from: f, to: t, mode, added, resolved, set, unset }) => ({ main, from: f, to: t, mode,
    added: added.map(({ sev, code, file, line, msg, was }) => ({ severity: sev, was, code, file, line, message: msg })),
    resolved: resolved.map(({ sev, code, file, line, msg, was }) => ({ severity: sev, was, code, file, line, message: msg })), set, unset })), null, 2));
  else console.log(reports.map((r) => upgradeMarkdown(r, { source: `Main config: ${r.main}` })).join('\n'));
  const rank = { info: 1, warning: 2, error: 3, never: 99 };
  const worst = Math.max(0, ...reports.flatMap((r) => r.added.map((f) => rank[f.sev])));
  process.exit(worst >= (rank[opt.failOn] ?? 3) ? 1 : 0);
}

// Check every file that can be a main config, skipping those already merged into another as fragments or includes.
const mains = opt.main ? [opt.main] : mainCandidates(files);
const consumed = new Set();
let all = [];
for (const m of mains) {
  if (consumed.has(m)) continue;
  const r = analyzeSet(files, { schema, mode: opt.mode, mainPath: m, substitutions: subst, version: opt.version });
  for (const p of r.plan) if (p.role === 'fragment' || p.role === 'include' || p.role === 'main') consumed.add(p.path);
  for (const f of r.findings) if (!all.some((x) => x.file === f.file && x.line === f.line && x.code === f.code && x.msg === f.msg)) all.push(f);
  if (opt.format === 'text') console.error(`checked ${r.mainPath} (${r.mode}) with ${r.plan.filter((p) => p.role === 'fragment').length} fragment(s)`);
}

// Report paths as given on the command line, so CI annotations land on the right file.
const shown = new Map(files.map((f) => [f.path, f.shown]));
all = all.map((f) => ({ ...f, file: shown.get(f.file) || f.file }));

const out = { text: toText, markdown: (f) => toMarkdown(f, { meta: `Target: ${opt.version}` }), json: (f) => toJson(f, { version: opt.version }), github: toGithub }[opt.format];
if (!out) die(`unknown --format ${opt.format}`);
const s = out(all);
if (s) console.log(s);
const rank = { info: 1, warning: 2, error: 3, never: 99 };
const worst = Math.max(0, ...all.map((f) => rank[f.sev]));
process.exit(worst >= (rank[opt.failOn] ?? 3) ? 1 : 0);
