// Plain-text, Markdown, JSON and GitHub-annotation renderings of findings, shared by the page and the CLI.

const LABEL = { error: 'error', warning: 'warning', info: 'note' };
const loc = (f) => `${f.file ? `${f.file}:` : ''}${f.line}`;

export function toText(findings) {
  return findings.map((f) => `${loc(f)}: ${LABEL[f.sev]} [${f.code}] ${f.path ? `${f.path}: ` : ''}${f.msg}`).join('\n');
}

export function toMarkdown(findings, { title = 'ClickHouse config check', meta = '' } = {}) {
  const counts = ['error', 'warning', 'info'].map((s) => `${findings.filter((f) => f.sev === s).length} ${LABEL[s]}${s === 'info' ? 's' : 's'}`).join(', ');
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = findings.map((f) => `| ${LABEL[f.sev]} | \`${cell(loc(f))}\` | ${cell(f.path || '')} | ${cell(f.msg)}${f.refs?.length ? ` (${f.refs.map((r) => `[${cell(r.label)}](${r.url})`).join(', ')})` : ''} |`);
  return [`# ${title}`, '', meta ? `${meta}  \n${counts}` : counts, '', '| Severity | Location | Path | Finding |', '|---|---|---|---|', ...rows, ''].join('\n');
}

export function toJson(findings, extra = {}) {
  return JSON.stringify({ ...extra, findings: findings.map(({ sev, code, file, line, col, path, msg, refs, fix }) => ({ severity: sev, code, file, line, col, path, message: msg, refs: (refs || []).map((r) => r.url), ...(fix ? { fix } : {}) })) }, null, 2);
}

/** GitHub Actions workflow commands: annotations on the PR diff. */
export function toGithub(findings) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return findings.map((f) => `::${f.sev === 'info' ? 'notice' : f.sev} file=${escProp(f.file || '')},line=${f.line},col=${f.col || 1},title=${escProp(f.code)}::${esc(f.msg)}`).join('\n');
}
