// Usage: node test/cli.mjs <config file> [server|keeper|auto]
import { readFileSync } from 'node:fs';
import { analyze } from '../js/engine.js';

const schema = JSON.parse(readFileSync(new URL('../data/schema.json', import.meta.url)));
const [file, mode = 'auto'] = process.argv.slice(2);
const res = analyze(readFileSync(file, 'utf8'), { schema, mode });
console.log(`format=${res.format} mode=${res.mode} findings=${res.findings.length} recognized=${res.recognized.length}`);
for (const f of res.findings) console.log(`${f.sev.padEnd(7)} L${String(f.line).padEnd(5)} [${f.code}] ${f.path ? f.path + ': ' : ''}${f.msg}`);
