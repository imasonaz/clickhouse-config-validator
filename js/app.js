// UI wiring: editor with line gutter and highlight bands, findings list, settings table, formatter.

import { analyze } from './engine.js';
import { toXml, toYaml, formatYamlDoc } from './format.js';
import { SAMPLES } from './samples.js';

const $ = (s) => document.querySelector(s);
const els = {
  source: $('#source'), gutter: $('#gutter-inner'), backdrop: $('#backdrop-inner'), hint: $('#empty-hint'), editor: $('#editor'),
  mode: $('#mode'), format: $('#format'), sample: $('#sample'), file: $('#file'), upload: $('#upload'), clear: $('#clear'),
  filename: $('#filename'), summary: $('#summary'), meta: $('#meta'), tabs: [...document.querySelectorAll('.tab')],
  panels: { findings: $('#panel-findings'), settings: $('#panel-settings'), formatted: $('#panel-formatted') },
  generated: $('#generated'),
};

let schema = null;
let last = null;
let filter = { error: true, warning: true, info: true };
let activeLine = null;
const LH = 20;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Render `x` and <x> fragments in messages as code.
const fmtMsg = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/&lt;([A-Za-z_@#][\w.\-:\[\]]*(?:\s[^&]*?)?\/?)&gt;/g, '<code>&lt;$1&gt;</code>');

async function init() {
  const res = await fetch('data/schema.json');
  schema = await res.json();
  els.generated.textContent = `Settings data generated ${schema.generated} from ${schema.source}`;

  for (const s of SAMPLES) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.label;
    els.sample.append(o);
  }
  const saved = store.get('ccv.source');
  const savedName = store.get('ccv.name');
  if (saved && saved.trim()) setSource(saved, savedName || 'pasted config');
  else loadSample(SAMPLES[0].id);

  els.source.addEventListener('input', () => { els.filename.textContent = els.filename.textContent || 'pasted config'; schedule(); });
  els.source.addEventListener('scroll', syncScroll);
  els.source.addEventListener('keydown', onKey);
  els.mode.addEventListener('change', run);
  els.format.addEventListener('change', run);
  els.sample.addEventListener('change', () => { if (els.sample.value) loadSample(els.sample.value); els.sample.value = ''; });
  els.upload.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => { if (els.file.files[0]) readFile(els.file.files[0]); els.file.value = ''; });
  els.clear.addEventListener('click', () => { setSource('', ''); els.source.focus(); });
  for (const t of els.tabs) t.addEventListener('click', () => selectTab(t.dataset.tab));
  for (const ev of ['dragenter', 'dragover']) els.editor.addEventListener(ev, (e) => { e.preventDefault(); els.editor.classList.add('drag'); });
  for (const ev of ['dragleave', 'drop']) els.editor.addEventListener(ev, () => els.editor.classList.remove('drag'));
  els.editor.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  const tab = location.hash.replace('#', '');
  if (els.panels[tab]) selectTab(tab);
}

function readFile(f) {
  const r = new FileReader();
  r.onload = () => {
    if (/\.ya?ml$/i.test(f.name)) els.format.value = 'yaml';
    else if (/\.(xml|conf)$/i.test(f.name)) els.format.value = 'xml';
    setSource(String(r.result), f.name);
  };
  r.readAsText(f);
}

function loadSample(id) {
  const s = SAMPLES.find((x) => x.id === id);
  els.format.value = 'auto';
  els.mode.value = 'auto';
  setSource(s.text, `${s.name} (example)`);
}

function setSource(text, name) {
  els.source.value = text;
  els.filename.textContent = name;
  els.source.scrollTop = 0;
  activeLine = null;
  run();
}

let timer = null;
function schedule() { clearTimeout(timer); timer = setTimeout(run, 250); }

function run() {
  if (!schema) return;
  const text = els.source.value;
  store.set('ccv.source', text);
  store.set('ccv.name', els.filename.textContent);
  last = analyze(text, { schema, mode: els.mode.value, format: els.format.value });
  last.text = text;
  render();
}

function render() {
  const r = last;
  els.hint.hidden = !r.empty;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of r.findings) counts[f.sev]++;

  // Summary chips
  els.summary.innerHTML = '';
  if (!r.empty) {
    if (!counts.error && !counts.warning && !counts.info) {
      els.summary.innerHTML = '<span class="chip ok"><span class="dot"></span>No issues</span>';
    }
    for (const sev of ['error', 'warning', 'info']) {
      if (!counts[sev]) continue;
      const b = document.createElement('button');
      b.className = `chip ${sev}`;
      b.setAttribute('aria-pressed', String(filter[sev]));
      b.innerHTML = `<span class="dot"></span>${counts[sev]} ${sev === 'info' ? 'note' : sev}${counts[sev] === 1 || sev === 'info' && counts[sev] === 1 ? '' : 's'}`;
      b.title = `Show or hide ${sev} findings`;
      b.addEventListener('click', () => { filter[sev] = !filter[sev]; render(); });
      els.summary.append(b);
    }
  }
  const modeName = { server: 'server config', keeper: 'Keeper config', users: 'users config', auto: '' }[r.mode] || r.mode;
  els.meta.textContent = r.empty ? '' : `${r.format.toUpperCase()} · ${modeName}${els.mode.value === 'auto' && modeName ? ' (detected)' : ''}`;

  renderGutter();
  renderFindings();
  renderSettings();
  renderFormatted();
  els.tabs.find((t) => t.dataset.tab === 'findings').querySelector('.count').textContent = r.findings.length || '';
  els.tabs.find((t) => t.dataset.tab === 'settings').querySelector('.count').textContent = r.recognized?.length || '';
}

function lineSeverity() {
  const m = new Map();
  const rank = { error: 3, warning: 2, info: 1 };
  for (const f of last.findings) {
    if (!filter[f.sev]) continue;
    const cur = m.get(f.line);
    if (!cur || rank[f.sev] > rank[cur]) m.set(f.line, f.sev);
  }
  return m;
}

function renderGutter() {
  const n = Math.max(1, last.text.split('\n').length);
  const sev = lineSeverity();
  const out = [];
  for (let i = 1; i <= n; i++) {
    const s = sev.get(i);
    out.push(`<div class="ln${s ? ' ' + s : ''}"${s ? ` title="${s}"` : ''}>${i}</div>`);
  }
  els.gutter.innerHTML = out.join('');
  const bands = [];
  for (const [line, s] of sev) bands.push(`<div class="band ${s}" style="top:${(line - 1) * LH + 10}px"></div>`);
  if (activeLine) bands.push(`<div class="band focus" style="top:${(activeLine - 1) * LH + 10}px"></div>`);
  els.backdrop.innerHTML = bands.join('');
  els.backdrop.style.height = `${n * LH + 20}px`;
  syncScroll();
}

function syncScroll() {
  const t = els.source.scrollTop, l = els.source.scrollLeft;
  els.gutter.style.transform = `translateY(${-t}px)`;
  els.backdrop.style.transform = `translate(${-l}px, ${-t}px)`;
}

function renderFindings() {
  const p = els.panels.findings;
  const r = last;
  if (r.empty) { p.innerHTML = '<div class="all-clear">Paste a ClickHouse server, users or Keeper config (XML or YAML), drop a file on the editor, or pick an example.</div>'; return; }
  const list = r.findings.filter((f) => filter[f.sev]);
  if (!r.findings.length) {
    p.innerHTML = `<div class="all-clear"><strong>No issues found</strong>${r.recognized.length} recognised settings parsed and type-checked. Values set through from_env, from_zk or incl are not checked.</div>`;
    return;
  }
  if (!list.length) { p.innerHTML = '<div class="all-clear">All findings are hidden by the filters above.</div>'; return; }
  const ul = document.createElement('ul');
  ul.className = 'findings';
  for (const f of list) {
    const li = document.createElement('li');
    li.className = `finding ${f.sev}${activeLine === f.line ? ' active' : ''}`;
    li.tabIndex = 0;
    li.innerHTML = `<span class="sev">${f.sev === 'info' ? 'note' : f.sev}</span>
      <div class="body">${f.path ? `<div class="path">${esc(f.path)}</div>` : ''}<p class="msg">${fmtMsg(f.msg)}</p>
      <div class="refs">${f.refs.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener"${x.source ? ' class="src"' : ''}>${esc(x.label)}</a>`).join('')}</div></div>
      <span class="loc">line ${f.line}</span>`;
    const go = (e) => { if (e.target.closest('a')) return; jumpTo(f.line); };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e); });
    ul.append(li);
  }
  p.innerHTML = '';
  p.append(ul);
}

function jumpTo(line) {
  activeLine = line;
  const ta = els.source;
  const lines = ta.value.split('\n');
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  const end = pos + (lines[line - 1] || '').length;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(pos, end);
  ta.scrollTop = Math.max(0, (line - 1) * LH - ta.clientHeight / 3);
  if (window.matchMedia('(max-width: 980px)').matches) els.editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  renderGutter();
  for (const li of els.panels.findings.querySelectorAll('.finding')) li.classList.toggle('active', li.querySelector('.loc').textContent === `line ${line}`);
}

function renderSettings() {
  const p = els.panels.settings;
  const rows = last.recognized || [];
  if (!rows.length) { p.innerHTML = '<div class="all-clear">No recognised settings yet.</div>'; return; }
  const body = rows.map((r) => {
    const changed = r.def !== '' && r.value !== '' && normalize(r.value) !== normalize(r.def);
    return `<tr><td class="mono"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a><div class="note">${esc(r.scope)}</div></td>
      <td class="mono">${changed ? `<span class="changed">${esc(r.value)}</span>` : esc(r.value)}</td>
      <td class="mono">${esc(r.def)}</td><td class="mono">${esc(r.type)}</td><td class="mono">${r.line}</td></tr>`;
  }).join('');
  p.innerHTML = `<div class="settings-wrap"><table class="settings"><thead><tr><th>Setting</th><th>Value</th><th>Default</th><th>Type</th><th>Line</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
const normalize = (v) => String(v).trim().replace(/^"|"$/g, '').toLowerCase().replace(/^(true)$/, '1').replace(/^(false)$/, '0');

let outKind = 'same';
function renderFormatted() {
  const p = els.panels.formatted;
  const r = last;
  if (!r.doc) {
    p.innerHTML = `<div class="all-clear">${r.empty ? 'Nothing to format yet.' : 'Fix the syntax error first; formatting needs a parseable document.'}</div>`;
    return;
  }
  const other = r.format === 'xml' ? 'YAML' : 'XML';
  let text, note;
  if (outKind === 'same') {
    text = r.format === 'xml' ? toXml(r.doc) : formatYamlDoc(r.doc.ydoc);
    note = r.format === 'xml' ? 'Re-indented with 4 spaces; leaf values trimmed onto one line; comments kept.' : 'Re-indented with 2 spaces; comments kept.';
  } else {
    text = r.format === 'xml' ? toYaml(r.doc.root) : toXml({ root: r.doc.root, comments: [], prolog: [] });
    note = r.format === 'xml'
      ? 'Converted using the rules of ClickHouse\'s YAML parser: repeated elements become lists, attributes become "@name" keys.'
      : 'Converted to the XML that ClickHouse\'s YAML parser builds. YAML comments are not carried over.';
  }
  p.innerHTML = `<div class="out-tools">
      <button class="btn${outKind === 'same' ? ' primary' : ''}" id="out-same">Formatted ${r.format.toUpperCase()}</button>
      <button class="btn${outKind === 'other' ? ' primary' : ''}" id="out-other">Convert to ${other}</button>
      <button class="btn ghost" id="out-copy">Copy</button>
      <button class="btn ghost" id="out-use">Replace editor</button>
      <span class="note">${esc(note)}</span></div><pre class="out" id="out-text"></pre>`;
  $('#out-text').textContent = text;
  $('#out-same').onclick = () => { outKind = 'same'; renderFormatted(); };
  $('#out-other').onclick = () => { outKind = 'other'; renderFormatted(); };
  $('#out-copy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; }
    catch {
      const range = document.createRange(); range.selectNodeContents($('#out-text'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); e.target.textContent = 'Selected, press Ctrl+C';
    }
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1800);
  };
  $('#out-use').onclick = () => {
    if (outKind === 'other') els.format.value = 'auto';
    setSource(text, els.filename.textContent.replace(/( \(formatted\))?$/, ' (formatted)'));
    outKind = 'same';
  };
}

function selectTab(name) {
  for (const t of els.tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const [k, p] of Object.entries(els.panels)) p.hidden = k !== name;
  store.set('ccv.tab', name);
}

function onKey(e) {
  if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const ta = els.source, s = ta.selectionStart;
    const unit = (last && last.format === 'yaml') ? '  ' : '    ';
    ta.setRangeText(unit, s, ta.selectionEnd, 'end');
    schedule();
  }
}

init().catch((e) => {
  els.panels.findings.innerHTML = `<div class="all-clear">Could not load the settings data (${esc(e.message)}). Serve the site over HTTP, for example with <code>python3 -m http.server</code>, rather than opening the file directly.</div>`;
});
const savedTab = store.get('ccv.tab');
if (savedTab && els.panels[savedTab] && !location.hash) selectTab(savedTab);
