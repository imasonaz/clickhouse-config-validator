// UI wiring: file set with tabs, editor with line gutter and highlight bands, findings list, settings table,
// merge view, formatter with download.

import { analyze, analyzeSet, detectFormat } from './engine.js';
import { toXml, toYaml, formatYamlDoc } from './format.js';
import { SAMPLES } from './samples.js';
import { knownVersions, cmpVer } from './versions.js';
import { highlight } from './highlight.js';
import { upgradeReport, upgradeMarkdown, GROUP_LABEL } from './upgrade.js';
import { moveElement, unwrapLines } from './fix.js';
import { toMarkdown, toJson } from './report.js';
import { shareableState, encodeState, decodeState } from './share.js';
import { contextPath, lookup, complete } from './assist.js';

const $ = (s) => document.querySelector(s);
const els = {
  source: $('#source'),
  gutter: $('#gutter-inner'),
  backdrop: $('#backdrop-inner'),
  bands: $('#bands'),
  hl: $('#hl'),
  hint: $('#empty-hint'),
  editor: $('#editor'),
  mode: $('#mode'),
  format: $('#format'),
  version: $('#version'),
  sample: $('#sample'),
  file: $('#file'),
  folder: $('#folder'),
  upload: $('#upload'),
  uploadDir: $('#upload-dir'),
  clear: $('#clear'),
  share: $('#share'),
  toast: $('#toast'),
  hovercard: $('#hovercard'),
  ac: $('#ac'),
  filebar: $('#filebar'),
  summary: $('#summary'),
  meta: $('#meta'),
  viewsw: $('#viewsw'),
  tabs: [...document.querySelectorAll('.tab')],
  panels: {
    findings: $('#panel-findings'),
    settings: $('#panel-settings'),
    merge: $('#panel-merge'),
    upgrade: $('#panel-upgrade'),
    formatted: $('#panel-formatted'),
  },
  generated: $('#generated'),
};

let schema = null;
let last = null; // what the results pane shows
let set = null; // analyzeSet result when there is more than one file
const filter = { error: true, warning: true, info: true };
let activeLine = null;
let addMode = false; // next file pick adds to the set instead of replacing it
const LH = 20;

// state.files: [{ path, text, format }]; view: 'file' | 'merged'
const state = {
  files: [{ path: 'config.xml', text: '', format: 'auto' }],
  active: 0,
  view: 'merged',
  mainPath: '',
  subst: '',
  version: 'latest',
};
const activeFile = () => state.files[state.active];
const multi = () => state.files.length > 1;
const merged = () => multi() && state.view === 'merged';

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};
const save = () => store.set('ccv.files', JSON.stringify(state));

// Unsaved edits: the files as they were loaded (sample, upload, shared link) are the baseline. Anything that
// differs, including edits restored from an earlier visit, is the user's work and is not dropped silently.
const snapshot = () => JSON.stringify(state.files.map((f) => [f.path, f.text]));
let baseline = store.get('ccv.baseline');
function markClean() {
  baseline = snapshot();
  store.set('ccv.baseline', baseline);
}
const isDirty = () => state.files.some((f) => f.text.trim()) && snapshot() !== baseline;
function confirmDiscard(what) {
  if (!isDirty()) return true;
  const n = state.files.length;
  return confirm(
    `You have unsaved edits in ${n > 1 ? `${n} open files` : base(activeFile().path)}. ${what} will replace them.\n\nDownload them first from Format & export if you want to keep them. Discard the edits?`,
  );
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Render `x` and <x> fragments in messages as code.
const fmtMsg = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/&lt;([A-Za-z_@#][\w.\-:[\] ]*?\/?)&gt;/g, '<code>&lt;$1&gt;</code>');
// A finding's message, with the other files it names (f.related, from the cross-file checks) as links to the
// line they point at, so the conflicting values can be compared.
const msgHtml = (f) => {
  let html = fmtMsg(f.msg);
  const rel = (f.related || []).filter((r) => state.files.some((x) => x.path === r.file));
  for (const r of rel.sort((a, b) => b.text.length - a.text.length)) {
    const link = `<button class="linkish flink" type="button" data-file="${esc(r.file)}" data-line="${r.line}" title="Go to ${esc(shortPath(r.file))}, line ${r.line}">${esc(r.text)}</button>`;
    html = html.split(esc(r.text)).join(link);
  }
  return html;
};
const hasLinks = (f) => (f.related || []).some((r) => state.files.some((x) => x.path === r.file));
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
// File name for labels: the base name, or the whole path when another open file has the same base name.
const shortPath = (p) => {
  if (state.files.filter((f) => base(f.path) === base(p)).length < 2) return base(p);
  const parts = p.split('/');
  return parts.length > 2 ? `${parts[0]}/…/${parts[parts.length - 1]}` : p;
};
// The same as HTML that wraps only after a '/', never at a hyphen.
const fileLabel = (p) => esc(shortPath(p)).replace(/-/g, '\u2011').replace(/\//g, '/<wbr>');

async function init() {
  const res = await fetch('data/schema.json');
  schema = await res.json();
  els.generated.textContent = `Settings data generated ${schema.generated} from ${schema.source}`;

  for (const s of SAMPLES) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    els.sample.append(o);
  }
  for (const v of knownVersions(schema)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    els.version.append(o);
  }
  els.version.options[0].textContent = `Latest (${schema.source.replace(/^.*@/, '')})`;
  let restored = false;
  if (location.hash.startsWith('#s=')) {
    try {
      const shared = await decodeState(location.hash.slice(3));
      try {
        const saved = JSON.parse(store.get('ccv.files') || 'null');
        if (saved && Array.isArray(saved.files)) state.files = saved.files;
      } catch {
        /* ignore */
      }
      if (!confirmDiscard('Opening this shared link')) throw Object.assign(new Error(), { kept: true });
      Object.assign(state, {
        files: shared.files,
        subst: shared.subst || '',
        version: shared.version || 'latest',
        view: shared.view || 'merged',
        mainPath: shared.mainPath || '',
        active: Math.min(shared.active || 0, shared.files.length - 1),
      });
      restored = true;
      markClean();
      toast('Loaded from a shared link. Edits stay in this browser.');
    } catch (e) {
      toast(
        e.kept ? 'Kept your edits; the shared link was not opened.' : `Could not read the shared link (${e.message}).`,
      );
    }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!restored)
    try {
      const saved = JSON.parse(store.get('ccv.files') || 'null');
      if (saved && Array.isArray(saved.files) && saved.files.length && saved.files.some((f) => f.text.trim())) {
        Object.assign(state, saved);
        restored = true;
      }
    } catch {
      /* ignore */
    }
  if (!restored) {
    const legacy = store.get('ccv.source');
    if (legacy && legacy.trim()) {
      state.files = [{ path: store.get('ccv.name') || 'config.xml', text: legacy, format: 'auto' }];
      restored = true;
    }
  }
  if (![...els.version.options].some((o) => o.value === state.version)) state.version = 'latest';
  els.version.value = state.version;
  if (!restored) loadSample(SAMPLES[0].id);
  else showActive();

  els.source.addEventListener('input', (e) => {
    activeFile().text = els.source.value;
    activeLine = null;
    schedule();
    if (!editing && (e.inputType !== 'deleteContentBackward' || !els.ac.hidden)) suggestAt();
  });
  els.source.addEventListener('mousemove', onHover);
  els.source.addEventListener('mouseleave', () => hideHover(300));
  els.gutter.parentElement.addEventListener('mousemove', (e) => {
    const r = els.gutter.parentElement.getBoundingClientRect();
    showLineFindings(Math.floor((e.clientY - r.top + els.source.scrollTop - textMetrics().pt) / LH));
  });
  els.gutter.parentElement.addEventListener('mouseleave', () => hideHover(300));
  els.hovercard.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  // File links in finding messages, wherever they are rendered (findings list, upgrade report, hover card).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button.flink');
    if (b) jumpToFile(b.dataset.file, Number(b.dataset.line));
  });
  els.hovercard.addEventListener('mouseleave', () => hideHover(200));
  els.source.addEventListener('blur', () => setTimeout(closeAc, 150));
  els.source.addEventListener('click', closeAc);
  els.source.addEventListener('scroll', syncScroll);
  els.source.addEventListener('keydown', onKey);
  els.mode.addEventListener('change', run);
  els.share.addEventListener('click', share);
  els.version.addEventListener('change', () => {
    state.version = els.version.value;
    run();
  });
  els.format.addEventListener('change', () => {
    activeFile().format = els.format.value;
    run();
  });
  els.sample.addEventListener('change', () => {
    if (els.sample.value && confirmDiscard('Loading a sample')) loadSample(els.sample.value);
    els.sample.value = '';
  });
  els.upload.addEventListener('click', () => {
    addMode = false;
    els.file.click();
  });
  els.uploadDir.addEventListener('click', () => {
    addMode = false;
    els.folder.click();
  });
  els.file.addEventListener('change', () => {
    readFiles(
      [...els.file.files].map((f) => ({ f, path: f.name })),
      addMode,
    );
    els.file.value = '';
  });
  els.folder.addEventListener('change', () => {
    readFiles(
      [...els.folder.files].map((f) => ({ f, path: f.webkitRelativePath || f.name })),
      addMode,
      true,
    );
    els.folder.value = '';
  });
  els.clear.addEventListener('click', () => {
    if (!confirmDiscard('Clearing')) return;
    state.files = [{ path: 'config.xml', text: '', format: 'auto' }];
    state.active = 0;
    state.subst = '';
    markClean();
    showActive();
    els.source.focus();
  });
  for (const t of els.tabs) t.addEventListener('click', () => selectTab(t.dataset.tab));
  for (const ev of ['dragenter', 'dragover'])
    els.editor.addEventListener(ev, (e) => {
      e.preventDefault();
      els.editor.classList.add('drag');
    });
  for (const ev of ['dragleave', 'drop']) els.editor.addEventListener(ev, () => els.editor.classList.remove('drag'));
  els.editor.addEventListener('drop', onDrop);
  const tab = location.hash.replace('#', '');
  if (els.panels[tab]) selectTab(tab);
}

// ---------------------------------------------------------------- files

async function onDrop(e) {
  e.preventDefault();
  const items = [...(e.dataTransfer.items || [])]
    .map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry())
    .filter(Boolean);
  if (items.length) {
    const out = [];
    const walkEntry = (entry, prefix) =>
      new Promise((resolve) => {
        if (entry.isFile)
          entry.file((f) => {
            out.push({ f, path: prefix + entry.name });
            resolve();
          }, resolve);
        else if (entry.isDirectory) {
          const reader = entry.createReader();
          const all = [];
          const next = () =>
            reader.readEntries(async (batch) => {
              if (batch.length) {
                all.push(...batch);
                next();
                return;
              }
              for (const c of all) await walkEntry(c, `${prefix}${entry.name}/`);
              resolve();
            }, resolve);
          next();
        } else resolve();
      });
    for (const it of items) await walkEntry(it, '');
    const folder = items.length === 1 && items[0].isDirectory;
    readFiles(out, !folder && out.length === 1 && multi(), folder);
    return;
  }
  readFiles(
    [...e.dataTransfer.files].map((f) => ({ f, path: f.name })),
    false,
  );
}

/** Read picked or dropped files. add: append to the set; stripRoot: drop the shared top folder name. */
function readFiles(list, add, stripRoot = false) {
  list = list.filter(({ path }) => /\.(xml|ya?ml|conf)$/i.test(path) || list.length === 1);
  if (!list.length) return;
  if (stripRoot) {
    const tops = new Set(list.map(({ path }) => path.split('/')[0]));
    if (tops.size === 1 && list.every(({ path }) => path.includes('/')))
      list = list.map((x) => ({ ...x, path: x.path.slice(x.path.indexOf('/') + 1) }));
  }
  Promise.all(list.map(({ f, path }) => f.text().then((text) => ({ path, text, format: 'auto' })))).then((files) => {
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    if (
      add &&
      files.some((nf) => {
        const o = state.files.find((x) => x.path === nf.path);
        return o && o.text !== nf.text;
      }) &&
      !confirmDiscard(`Adding ${files.length > 1 ? 'these files' : base(files[0].path)}`)
    )
      return;
    if (!add && !confirmDiscard(`Opening ${files.length > 1 ? `${files.length} files` : base(files[0].path)}`)) return;
    if (add) {
      for (const nf of files) {
        const i = state.files.findIndex((x) => x.path === nf.path);
        if (i >= 0) state.files[i] = nf;
        else state.files.push(nf);
      }
      state.files = state.files.filter((f) => f.text.trim() || state.files.length === 1);
      state.active = state.files.findIndex((x) => x.path === files[0].path);
    } else {
      state.files = files;
      state.active = Math.max(
        0,
        files.findIndex((x) => !x.path.includes('.d/')),
      );
      state.mainPath = '';
    }
    state.view = 'merged';
    if (!add) markClean();
    showActive();
  });
}

function loadSample(id) {
  const s = SAMPLES.find((x) => x.id === id);
  els.mode.value = 'auto';
  state.files = s.files
    ? s.files.map((f) => ({ ...f, format: 'auto' }))
    : [{ path: s.name, text: s.text, format: 'auto' }];
  state.subst = s.substitutions || '';
  state.active = 0;
  state.mainPath = '';
  state.view = 'merged';
  markClean();
  showActive();
}

function showActive() {
  const f = activeFile();
  els.source.value = f.text;
  els.format.value = f.format || 'auto';
  els.source.scrollTop = 0;
  activeLine = null;
  run();
}

function setActive(i) {
  if (i === state.active) return;
  state.active = i;
  showActive();
}

function renderFilebar() {
  const roles = new Map((set?.plan || []).map((p) => [p.path, p]));
  const html = state.files
    .map((f, i) => {
      const p = roles.get(f.path);
      const role = multi() ? (p ? p.role : f.path === set?.mainPath ? 'main' : '') : '';
      return `<div class="ftab${i === state.active ? ' on' : ''}${role === 'ignored' ? ' dim' : ''}" role="tab" aria-selected="${i === state.active}" data-i="${i}" title="${esc(f.path)}${p?.reason ? ` (${esc(p.reason)})` : ''}. Double-click to rename.">
      <span class="fname">${esc(f.path)}</span>${role ? `<span class="role ${role}">${role}</span>` : ''}
      ${multi() ? `<button class="x" type="button" data-x="${i}" aria-label="Close ${esc(f.path)}">×</button>` : ''}</div>`;
    })
    .join('');
  els.filebar.innerHTML = `${html}<button class="btn ghost add" id="add-file" type="button" title="Add config.d / users.d fragments or an include_from file">+ Add file</button>`;
  for (const t of els.filebar.querySelectorAll('.ftab')) {
    t.addEventListener('click', (e) => {
      if (e.target.closest('.x')) return;
      setActive(Number(t.dataset.i));
    });
    t.addEventListener('dblclick', () => renameFile(Number(t.dataset.i)));
  }
  for (const x of els.filebar.querySelectorAll('.x'))
    x.addEventListener('click', () => {
      const i = Number(x.dataset.x),
        f = state.files[i];
      const orig = (() => {
        try {
          return JSON.parse(baseline || '[]').find(([p]) => p === f.path);
        } catch {
          return null;
        }
      })();
      if (
        f.text.trim() &&
        (!orig || orig[1] !== f.text) &&
        !confirm(`${f.path} has unsaved edits. Close it and discard them?`)
      )
        return;
      state.files.splice(i, 1);
      if (state.active >= state.files.length || state.active > i) state.active = Math.max(0, state.active - 1);
      showActive();
    });
  $('#add-file').addEventListener('click', () => {
    addMode = true;
    els.file.click();
  });
}

function renameFile(i) {
  const f = state.files[i];
  const name = prompt('File path (use config.d/name.xml for a fragment, users.d/… for users fragments):', f.path);
  if (!name || name.trim() === f.path) return;
  if (state.files.some((x) => x.path === name.trim())) {
    alert(`There is already a file named ${name}.`);
    return;
  }
  if (state.mainPath === f.path) state.mainPath = name.trim();
  f.path = name.trim();
  run();
}

// ---------------------------------------------------------------- analysis

let timer = null;
function schedule() {
  paint();
  clearTimeout(timer);
  timer = setTimeout(run, 250);
}

function run() {
  if (!schema) return;
  save();
  const f = activeFile();
  if (multi()) {
    set = analyzeSet(state.files, {
      schema,
      mode: els.mode.value,
      mainPath: state.mainPath,
      substitutions: state.subst,
      version: state.version,
    });
    if (merged()) {
      last = {
        findings: set.findings,
        recognized: set.recognized,
        mode: set.mode,
        format: 'xml',
        doc: set.merged,
        merged: true,
        empty: false,
      };
    } else {
      const own = set.perFile.get(f.path);
      last = { ...own, findings: [...own.findings, ...set.cross.filter((x) => x.file === f.path)] };
    }
  } else {
    set = null;
    last = analyze(f.text, { schema, mode: els.mode.value, format: f.format || 'auto', version: state.version });
    for (const x of last.findings) x.file = f.path;
  }
  render();
}

function render() {
  const r = last;
  els.hint.hidden = !!activeFile().text.trim();
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of r.findings) counts[f.sev]++;

  els.summary.innerHTML = '';
  if (!r.empty) {
    if (!counts.error && !counts.warning && !counts.info)
      els.summary.innerHTML = '<span class="chip ok"><span class="dot"></span>No issues</span>';
    for (const sev of ['error', 'warning', 'info']) {
      if (!counts[sev]) continue;
      const b = document.createElement('button');
      b.className = `chip ${sev}`;
      b.setAttribute('aria-pressed', String(filter[sev]));
      b.innerHTML = `<span class="dot"></span>${counts[sev]} ${sev === 'info' ? 'note' : sev}${counts[sev] === 1 ? '' : 's'}`;
      b.title = `Show or hide ${sev} findings`;
      b.addEventListener('click', () => {
        filter[sev] = !filter[sev];
        render();
      });
      els.summary.append(b);
    }
  }
  const modeName =
    { server: 'server config', keeper: 'Keeper config', users: 'users config', auto: '' }[r.mode] || r.mode;
  els.meta.textContent = r.empty
    ? ''
    : r.merged
      ? `merged · ${modeName}`
      : `${(r.format || '').toUpperCase()} · ${modeName}${els.mode.value === 'auto' && modeName ? ' (detected)' : ''}`;

  renderViewSwitch();
  renderFilebar();
  renderGutter();
  renderFindings();
  renderSettings();
  renderMerge();
  renderUpgrade();
  renderFormatted();
  els.tabs.find((t) => t.dataset.tab === 'findings').querySelector('.count').textContent = r.findings.length || '';
  els.tabs.find((t) => t.dataset.tab === 'settings').querySelector('.count').textContent = r.recognized?.length || '';
  els.tabs.find((t) => t.dataset.tab === 'merge').querySelector('.count').textContent = multi()
    ? state.files.length
    : '';
}

function renderViewSwitch() {
  if (!multi()) {
    els.viewsw.hidden = true;
    return;
  }
  els.viewsw.hidden = false;
  const mains = set?.mains || [];
  els.viewsw.innerHTML = `<div class="seg" role="group" aria-label="Results for">
      <button type="button" data-v="merged" aria-pressed="${state.view === 'merged'}">Merged</button>
      <button type="button" data-v="file" aria-pressed="${state.view === 'file'}">This file</button></div>
    ${state.view === 'merged' && mains.length > 1 ? `<select id="mainsel" aria-label="Main config file">${mains.map((m) => `<option${m === set.mainPath ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>` : ''}`;
  for (const b of els.viewsw.querySelectorAll('[data-v]'))
    b.addEventListener('click', () => {
      state.view = b.dataset.v;
      run();
    });
  const ms = $('#mainsel');
  if (ms)
    ms.addEventListener('change', () => {
      state.mainPath = ms.value;
      run();
    });
}

// Findings that belong to the file in the editor.
const forActive = (f) => !f.file || f.file === activeFile().path;

function lineSeverity() {
  const m = new Map();
  const rank = { error: 3, warning: 2, info: 1 };
  for (const f of last.findings) {
    if (!filter[f.sev] || !forActive(f)) continue;
    const cur = m.get(f.line);
    if (!cur || rank[f.sev] > rank[cur]) m.set(f.line, f.sev);
  }
  return m;
}

function renderGutter() {
  const n = Math.max(1, els.source.value.split('\n').length);
  const sev = lineSeverity();
  const out = [];
  for (let i = 1; i <= n; i++) {
    const s = sev.get(i);
    out.push(`<div class="ln${s ? ' ' + s : ''}">${i}</div>`);
  }
  els.gutter.innerHTML = out.join('');
  const bands = [];
  for (const [line, s] of sev) bands.push(`<div class="band ${s}" style="top:${(line - 1) * LH + 10}px"></div>`);
  if (activeLine) bands.push(`<div class="band focus" style="top:${(activeLine - 1) * LH + 10}px"></div>`);
  els.bands.innerHTML = bands.join('');
  els.backdrop.style.height = `${n * LH + 20}px`;
  paint();
}

// Syntax colouring. Very large files stay plain so typing remains responsive.
const HL_LIMIT = 400000;
function paint() {
  const text = els.source.value;
  const on = text.length <= HL_LIMIT;
  els.editor.classList.toggle('hl-on', on);
  els.hl.innerHTML = on ? highlight(text, fmtOfActive()) + '\n' : '';
  syncScroll();
}

function syncScroll() {
  const t = els.source.scrollTop,
    l = els.source.scrollLeft;
  els.gutter.style.transform = `translateY(${-t}px)`;
  els.backdrop.style.transform = `translate(${-l}px, ${-t}px)`;
}

function renderFindings() {
  const p = els.panels.findings;
  const r = last;
  if (r.empty) {
    p.innerHTML =
      '<div class="all-clear">Paste a ClickHouse server, users or Keeper config (XML or YAML), drop files or a whole config folder on the editor, or pick an example.</div>';
    return;
  }
  const list = r.findings.filter((f) => filter[f.sev]);
  if (!r.findings.length) {
    p.innerHTML = `<div class="all-clear"><strong>No issues found</strong>${r.recognized.length} recognised settings parsed and type-checked.${r.merged ? '' : ' Values set through from_env, from_zk or incl are not checked.'}</div>`;
    return;
  }
  if (!list.length) {
    p.innerHTML = '<div class="all-clear">All findings are hidden by the filters above.</div>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'findings';
  const showFile = multi();
  for (const f of list) {
    const li = document.createElement('li');
    li.className = `finding ${f.sev}${activeLine === f.line && forActive(f) ? ' active' : ''}`;
    li.tabIndex = 0;
    const fix = fixButton(f);
    li.innerHTML = `<span class="sev">${f.sev === 'info' ? 'note' : f.sev}</span>
      <div class="body">${f.path ? `<div class="path">${esc(f.path)}</div>` : ''}<p class="msg">${msgHtml(f)}</p>
      ${fix ? `<div class="fix">${fix}</div>` : ''}
      <div class="refs">${f.refs.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener"${x.source ? ' class="src"' : ''}>${esc(x.label)}</a>`).join('')}</div></div>
      <span class="loc">${showFile && f.file ? `<span class="lf" title="${esc(f.file)}">${fileLabel(f.file)}</span>` : ''}line ${f.line}</span>`;
    const go = (e) => {
      if (e.target.closest('a, button')) return;
      jumpToFinding(f);
    };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go(e);
    });
    for (const b of li.querySelectorAll('[data-fix]')) b.addEventListener('click', () => applyFix(f, b.dataset.to));
    ul.append(li);
  }
  p.innerHTML = `<div class="out-tools find-tools"><span>Export findings</span>
      <button class="btn small" type="button" id="exp-md">Markdown</button><button class="btn small" type="button" id="exp-json">JSON</button></div>`;
  p.append(ul);
  const stem = (merged() ? base(set.mainPath) : base(activeFile().path)).replace(/\.[^.]+$/, '') || 'config';
  const meta = `${merged() ? `${set.mainPath} with ${set.plan.filter((x) => x.role === 'fragment').length} fragment(s), merged` : activeFile().path} · target ${state.version}`;
  $('#exp-md').onclick = () => download(`${stem}-findings.md`, toMarkdown(r.findings, { meta }), 'text/markdown');
  $('#exp-json').onclick = () =>
    download(`${stem}-findings.json`, toJson(r.findings, { source: meta, version: state.version }), 'application/json');
}

// ---------------------------------------------------------------- quick fixes

// Moves are offered for concrete destinations only (not "any profile"), and not out of a users profile,
// whose server-level destination is usually a different file.
const moveTargets = (f) =>
  f.fix.kind === 'move' && f.code !== 'unknown-setting' ? f.fix.to.filter((p) => !p.includes('<')).slice(0, 3) : [];

function fixButton(f) {
  if (f.fix?.kind === 'unwrap') return '<button class="btn small" type="button" data-fix>Join wrapped lines</button>';
  if (!f.fix || !f.fix.from || !f.file) return '';
  if (f.fix.kind === 'rename')
    return `<button class="btn small" type="button" data-fix>Rename to &lt;${esc(f.fix.to)}&gt;</button>`;
  const label = (p) =>
    p
      ? p
          .split('.')
          .map((x) => `&lt;${esc(x)}&gt;`)
          .join(' › ')
      : 'top level';
  return moveTargets(f)
    .map((p) => `<button class="btn small" type="button" data-fix data-to="${esc(p)}">Move to ${label(p)}</button>`)
    .join('');
}

/** Rename the element on the finding's line, in its own file (XML open/close tags or a YAML key), or move it
 *  under another section (`dest`). */
function applyFix(f, dest) {
  if (f.fix.kind === 'unwrap') {
    const file = f.file ? state.files.find((x) => x.path === f.file) : activeFile();
    if (!file) return;
    commitEdit(state.files.indexOf(file), unwrapLines(file.text), f.line);
    return;
  }
  const i = state.files.findIndex((x) => x.path === f.file);
  if (i < 0) return;
  const file = state.files[i];
  const { from, to } = f.fix;
  const fmt =
    file.format && file.format !== 'auto'
      ? file.format
      : /\.ya?ml$/i.test(file.path)
        ? 'yaml'
        : /\.(xml|conf)$/i.test(file.path)
          ? 'xml'
          : detectFormat(file.text);
  let out = null;
  if (dest != null) {
    const out = moveElement(file.text, fmt, f.line, from, dest);
    if (out == null) {
      toast("Couldn't move it automatically here; edit it by hand.");
      return;
    }
    const at = out
      .split('\n')
      .findIndex((l) => new RegExp(`^\\s*(<${escRe(from)}[\\s/>]|["']?${escRe(from)}["']?\\s*:)`).test(l));
    commitEdit(i, out, at >= 0 ? at + 1 : null);
    return;
  }
  if (fmt === 'yaml') {
    const lines = file.text.split('\n');
    const re = new RegExp(`^(\\s*(?:-\\s+)?)(["']?)${escRe(from)}\\2(\\s*:)`);
    if (re.test(lines[f.line - 1])) {
      lines[f.line - 1] = lines[f.line - 1].replace(re, `$1$2${to}$2$3`);
      out = lines.join('\n');
    }
  } else {
    const text = file.text;
    const start = text
      .split('\n')
      .slice(0, f.line - 1)
      .reduce((a, l) => a + l.length + 1, 0);
    const open = new RegExp(`<${escRe(from)}(?=[\\s/>])`, 'g');
    open.lastIndex = start;
    const m = open.exec(text);
    if (m) {
      const tagEnd = text.indexOf('>', m.index);
      const selfClosing = text[tagEnd - 1] === '/';
      out = text.slice(0, m.index) + `<${to}` + text.slice(m.index + from.length + 1);
      if (!selfClosing) {
        const close = new RegExp(`</${escRe(from)}\\s*>`, 'g');
        close.lastIndex = m.index + to.length + 1;
        const c = close.exec(out);
        if (c) out = out.slice(0, c.index) + `</${to}>` + out.slice(c.index + c[0].length);
      }
    }
  }
  if (out != null) commitEdit(i, out, f.line);
}

/** Show file i and change its text as an edit in the editor, so Ctrl+Z / Ctrl+Y undo and redo quick fixes. */
function commitEdit(i, next, line) {
  if (i !== state.active) {
    state.active = i;
    showActive();
  }
  editText(next);
  if (line) jumpTo(line);
}

// Programmatic edits go through the browser's editing commands, which keep the textarea's undo history
// (assigning .value would wipe it). Only the changed span is replaced.
let editing = false;
function editText(next, start, end) {
  const ta = els.source,
    prev = ta.value;
  if (start == null) {
    if (next === prev) return;
    let p = 0;
    while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
    let q = 0;
    while (q < prev.length - p && q < next.length - p && prev[prev.length - 1 - q] === next[next.length - 1 - q]) q++;
    start = p;
    end = prev.length - q;
    next = next.slice(p, next.length - q);
  }
  const expected = prev.slice(0, start) + next + prev.slice(end);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, end);
  editing = true;
  let ok = false;
  try {
    ok = next ? document.execCommand('insertText', false, next) : document.execCommand('delete');
  } catch {
    ok = false;
  }
  editing = false;
  if (!ok || ta.value !== expected) {
    ta.value = expected;
    ta.setSelectionRange(start + next.length, start + next.length);
    activeFile().text = expected;
    schedule();
  }
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function jumpToFinding(f) {
  jumpToFile(f.file, f.line);
}

/** Open `file` (when it is one of the loaded files and not already shown) and select `line`. */
function jumpToFile(file, line) {
  hideHover();
  if (file && file !== activeFile().path) {
    const i = state.files.findIndex((x) => x.path === file);
    if (i >= 0) {
      state.active = i;
      showActive();
    }
  }
  jumpTo(line);
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
  if (window.matchMedia('(max-width: 980px)').matches)
    els.editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  renderGutter();
  renderFindings();
}

// ---------------------------------------------------------------- settings, merge, format

function renderSettings() {
  const p = els.panels.settings;
  const rows = last.recognized || [];
  if (!rows.length) {
    p.innerHTML = '<div class="all-clear">No recognised settings yet.</div>';
    return;
  }
  const showFile = multi();
  const body = rows
    .map((r) => {
      const changed = r.def !== '' && r.value !== '' && normalize(r.value) !== normalize(r.def);
      return `<tr><td class="mono"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>${r.tier ? ` <span class="role tier-${r.tier}">${esc(r.tier.replace('_', ' '))}</span>` : ''}<div class="note">${esc(r.scope)}</div></td>
      <td class="mono">${changed ? `<span class="changed">${esc(r.value)}</span>` : esc(r.value)}</td>
      <td class="mono">${esc(r.def)}${r.hist ? `<div class="note" title="Default changes by version">${esc(r.hist)}</div>` : ''}</td><td class="mono">${esc(r.type)}</td>
      <td class="mono"><button class="linkish" type="button" data-file="${esc(r.file || '')}" data-line="${r.line}">${showFile && r.file ? `${esc(shortPath(r.file))}:` : ''}${r.line}</button></td></tr>`;
    })
    .join('');
  p.innerHTML = `<div class="settings-wrap"><table class="settings"><thead><tr><th>Setting</th><th>Value</th><th>Default${state.version !== 'latest' ? ` in ${esc(state.version)}` : ''}</th><th>Type</th><th>${showFile ? 'Source' : 'Line'}</th></tr></thead><tbody>${body}</tbody></table></div>`;
  for (const b of p.querySelectorAll('[data-line]'))
    b.addEventListener('click', () =>
      jumpToFinding({ file: b.dataset.file || undefined, line: Number(b.dataset.line) }),
    );
}
const normalize = (v) =>
  String(v)
    .trim()
    .replace(/^"|"$/g, '')
    .toLowerCase()
    .replace(/^(true)$/, '1')
    .replace(/^(false)$/, '0');

const ROLE_TEXT = {
  main: 'Main config. Fragments merge into it.',
  fragment: 'Merged into the main config, in this order.',
  include: 'include_from file: supplies incl substitutions.',
  separate: 'Loaded as its own config. Choose it as the main file to check it.',
  ignored: 'Not loaded by ClickHouse.',
};

function renderMerge() {
  const p = els.panels.merge;
  const subst = `<div class="subst">
      <label for="subst">Substitutions <span class="note">for from_env and from_zk: one per line, <code>NAME=value</code> for environment variables, <code>/zk/path=value</code> for ZooKeeper nodes</span></label>
      <textarea id="subst" spellcheck="false" rows="4" placeholder="CH_MAX_CONNECTIONS=4096&#10;/clickhouse/config/http_port=8123">${esc(state.subst)}</textarea></div>`;
  if (!multi()) {
    p.innerHTML = `<div class="merge-intro"><p>ClickHouse merges every file in <code>config.d/</code> (or <code>users.d/</code> for users.xml) into the main file, in name order, then applies <code>incl</code>, <code>from_env</code> and <code>from_zk</code> substitutions. Add those files to check the result as the server will see it.</p>
      <div class="out-tools"><button class="btn primary" id="m-add" type="button">Add files</button><button class="btn" id="m-dir" type="button">Open config folder</button>
      <span class="note">Name fragments like <code>config.d/10-logging.xml</code>. Double-click a file tab to rename it.</span></div></div>${subst}`;
    $('#m-add').onclick = () => {
      addMode = true;
      els.file.click();
    };
    $('#m-dir').onclick = () => {
      addMode = false;
      els.folder.click();
    };
  } else {
    let n = 0;
    const rows = set.plan
      .map(
        (
          x,
        ) => `<li class="plan-row ${x.role}"><span class="ord">${x.role === 'fragment' || x.role === 'main' ? ++n : ''}</span>
      <button class="linkish mono" type="button" data-open="${esc(x.path)}">${esc(x.path)}</button><span class="role ${x.role}">${x.role}</span>
      <span class="note">${esc(x.reason ? `${ROLE_TEXT[x.role]} ${x.reason[0].toUpperCase()}${x.reason.slice(1)}.` : ROLE_TEXT[x.role])}</span></li>`,
      )
      .join('');
    const ev = set.events
      .map(
        (
          e,
        ) => `<li><button class="linkish mono" type="button" data-open="${esc(e.file)}" data-line="${e.line}">${esc(base(e.file))}:${e.line}</button>
      ${
        e.type === 'override'
          ? `sets <code>${esc(e.target)}</code> to <code>${esc(e.to)}</code> (was <code>${esc(e.from)}</code>)`
          : e.type === 'replace'
            ? `replaces <code>${esc(e.target)}</code>`
            : e.type === 'remove'
              ? `removes <code>${esc(e.target)}</code>`
              : `asks to remove <code>${esc(e.target)}</code>, which doesn't exist`
      }</li>`,
      )
      .join('');
    p.innerHTML = `<div class="merge-intro"><ol class="plan">${rows}</ol></div>${subst}
      <div class="merge-log"><h3>What the fragments change</h3>${ev ? `<ul>${ev}</ul>` : '<p class="note">No overrides, replacements or removals; fragments only add new elements.</p>'}</div>`;
    for (const b of p.querySelectorAll('[data-open]'))
      b.addEventListener('click', () => jumpToFinding({ file: b.dataset.open, line: Number(b.dataset.line || 1) }));
  }
  const ta = $('#subst');
  ta.addEventListener('input', () => {
    state.subst = ta.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const pos = ta.selectionStart;
      run();
      const t = $('#subst');
      t.focus();
      t.setSelectionRange(pos, pos);
    }, 400);
  });
}

// ---------------------------------------------------------------- upgrade report

// Default "from": the newest LTS (x.3 / x.8) before the target that isn't the release right before it.
function defaultUpgradeFrom(to) {
  const vs = knownVersions(schema).filter((v) => to === 'latest' || cmpVer(v, to) < 0);
  return vs.find((v, i) => /\.(3|8)$/.test(v) && i > 0) || vs[Math.min(4, vs.length - 1)];
}

let upgradeCache = { key: '', report: null };
function renderUpgrade() {
  const p = els.panels.upgrade;
  if (p.hidden || !schema) return;
  if (last.empty) {
    p.innerHTML =
      '<div class="all-clear">Load a config to see what changes for it between two ClickHouse releases.</div>';
    return;
  }
  const versions = knownVersions(schema);
  const to = state.upTo && (state.upTo === 'latest' || versions.includes(state.upTo)) ? state.upTo : versions[0];
  let from = state.upFrom && versions.includes(state.upFrom) ? state.upFrom : defaultUpgradeFrom(to);
  if (to !== 'latest' && cmpVer(from, to) >= 0) from = defaultUpgradeFrom(to);
  const key = JSON.stringify([
    state.files.map((f) => [f.path, f.text, f.format]),
    state.mainPath,
    state.subst,
    els.mode.value,
    from,
    to,
  ]);
  if (upgradeCache.key !== key)
    upgradeCache = {
      key,
      report: upgradeReport(state.files, {
        schema,
        from,
        to,
        mode: els.mode.value,
        mainPath: state.mainPath,
        substitutions: state.subst,
      }),
    };
  const r = upgradeCache.report;
  const opts = (sel, list) =>
    list
      .map(
        (v) =>
          `<option value="${v}"${v === sel ? ' selected' : ''}>${v === 'latest' ? 'master (unreleased)' : v}</option>`,
      )
      .join('');
  const tools = `<div class="out-tools"><label class="up-sel">From <select id="up-from">${opts(from, versions.slice(1))}</select></label>
      <label class="up-sel">to <select id="up-to">${opts(to, ['latest', ...versions])}</select></label>
      ${r.error ? '' : '<button class="btn" id="up-dl" type="button">Download report</button>'}
      <span class="note">Runs every check at both versions and compares, then lists default and tier changes in between.</span></div>`;
  if (r.error) {
    p.innerHTML = `${tools}<div class="all-clear">${esc(r.error)}</div>`;
    bindUpgrade(from, to);
    return;
  }
  const showFile = multi();
  const fl = (list) =>
    `<ul class="findings">${list
      .map(
        (
          f,
          i,
        ) => `<li class="finding ${f.sev}" tabindex="0" data-i="${i}"><span class="sev">${f.sev === 'info' ? 'note' : f.sev}</span>
      <div class="body">${f.path ? `<div class="path">${esc(f.path)}</div>` : ''}<p class="msg">${msgHtml(f)}</p>${f.was ? `<div class="note">Was ${f.was === 'info' ? 'a note' : `a ${f.was}`} on ${esc(from)}.</div>` : ''}</div>
      <span class="loc">${showFile && f.file ? `<span class="lf" title="${esc(f.file)}">${fileLabel(f.file)}</span>` : ''}line ${f.line}</span></li>`,
      )
      .join('')}</ul>`;
  const chg = (cs) =>
    cs
      .map(
        (c) => `<div><span class="note">${esc(c.version)}</span> ${esc(c.from)} → <strong>${esc(c.to)}</strong></div>`,
      )
      .join('');
  const setRows = r.set
    .map(
      (
        x,
      ) => `<tr><td class="mono"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a><div class="note">${esc(x.scope)}</div></td>
      <td class="mono">${esc(x.value)}</td><td class="mono">${chg(x.changes)}</td><td class="mono">${x.tier ? `${esc(x.tier.from.replace('_', ' '))} → <strong>${esc(x.tier.to.replace('_', ' '))}</strong>` : ''}</td></tr>`,
    )
    .join('');
  const unsetCount = Object.values(r.unset).reduce((n, rows) => n + rows.length, 0);
  const unset = Object.entries(r.unset)
    .map(
      ([
        g,
        rows,
      ]) => `<details class="up-group"><summary>${esc(GROUP_LABEL[g])} <span class="note">${rows.length}</span></summary>
      <div class="settings-wrap"><table class="settings"><thead><tr><th>Setting</th><th>Default changes</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td class="mono">${esc(x.name)}</td><td class="mono">${chg(x.changes)}</td></tr>`).join('')}</tbody></table></div></details>`,
    )
    .join('');
  const toName = to === 'latest' ? 'master' : to;
  p.innerHTML = `${tools}<div class="upgrade">
    <p class="up-sum"><strong>${r.added.length}</strong> new finding${r.added.length === 1 ? '' : 's'} at ${esc(toName)}, <strong>${r.resolved.length}</strong> resolved, <strong>${r.set.length}</strong> of your settings changed default or tier, and <strong>${unsetCount}</strong> defaults changed for settings you leave unset.</p>
    <h3>New at ${esc(toName)}</h3>${r.added.length ? fl(r.added) : `<p class="note">Nothing new: no finding appears on ${esc(toName)} that isn't already there on ${esc(from)}.</p>`}
    ${r.resolved.length ? `<h3>Resolved by ${esc(toName)}</h3>${fl(r.resolved)}` : ''}
    <h3>Settings you set</h3>${r.set.length ? `<div class="settings-wrap"><table class="settings"><thead><tr><th>Setting</th><th>Your value</th><th>Default changes</th><th>Tier</th></tr></thead><tbody>${setRows}</tbody></table></div>` : '<p class="note">No default or tier changes for the settings this config sets.</p>'}
    ${unset ? `<h3>Defaults that change under you</h3><p class="note">Settings this config doesn't set, whose default changed between ${esc(from)} and ${esc(toName)}.</p>${unset}` : ''}</div>`;
  const lists = p.querySelectorAll('.upgrade ul.findings');
  const srcs = [r.added, r.resolved];
  lists.forEach((ul, k) => {
    for (const li of ul.querySelectorAll('li'))
      li.addEventListener('click', (e) => {
        if (!e.target.closest('a, button')) jumpToFinding(srcs[k][Number(li.dataset.i)]);
      });
  });
  $('#up-dl').onclick = () => {
    const stem = (merged() ? base(set.mainPath) : base(activeFile().path)).replace(/\.[^.]+$/, '') || 'config';
    download(
      `${stem}-upgrade-${from}-to-${toName}.md`,
      upgradeMarkdown(r, { source: merged() ? `${set.mainPath}, merged with its fragments` : activeFile().path }),
      'text/markdown',
    );
  };
  bindUpgrade(from, to);
}
function bindUpgrade(from, to) {
  $('#up-from').onchange = (e) => {
    state.upFrom = e.target.value;
    save();
    renderUpgrade();
  };
  $('#up-to').onchange = (e) => {
    state.upTo = e.target.value;
    if (state.upTo !== 'latest' && cmpVer(state.upFrom || from, state.upTo) >= 0) state.upFrom = '';
    save();
    renderUpgrade();
  };
}

let outKind = 'same';
function renderFormatted() {
  const p = els.panels.formatted;
  const r = last;
  if (!r.doc) {
    p.innerHTML = `<div class="all-clear">${r.empty ? 'Nothing to format yet.' : 'Fix the syntax error first; formatting needs a parseable document.'}</div>`;
    return;
  }
  const f = activeFile();
  let text, note, name, labels;
  if (r.merged) {
    labels = ['Merged XML', 'Merged YAML'];
    const stem = base(set.mainPath).replace(/\.[^.]+$/, '');
    if (outKind === 'same') {
      text = toXml({ root: r.doc.root, comments: [], prolog: [] });
      name = `${stem}-preprocessed.xml`;
    } else {
      text = toYaml(r.doc.root);
      name = `${stem}-preprocessed.yaml`;
    }
    note =
      "The effective config after merging fragments and applying the substitutions you provided, like ClickHouse's *-preprocessed.xml. Comments are not kept.";
  } else {
    const other = r.format === 'xml' ? 'YAML' : 'XML';
    labels = [`Formatted ${r.format.toUpperCase()}`, `Convert to ${other}`];
    const stem = base(f.path).replace(/\.[^.]+$/, '') || 'config';
    if (outKind === 'same') {
      text = r.format === 'xml' ? toXml(r.doc) : formatYamlDoc(r.doc.ydoc);
      note =
        r.format === 'xml'
          ? 'Re-indented with 4 spaces; leaf values trimmed onto one line; comments kept.'
          : 'Re-indented with 2 spaces; comments kept.';
      name = /\.[^./]+$/.test(base(f.path)) ? base(f.path) : `${stem}.${r.format === 'xml' ? 'xml' : 'yaml'}`;
    } else {
      text = r.format === 'xml' ? toYaml(r.doc.root) : toXml({ root: r.doc.root, comments: [], prolog: [] });
      note =
        r.format === 'xml'
          ? 'Converted using the rules of ClickHouse\'s YAML parser: repeated elements become lists, attributes become "@name" keys.'
          : "Converted to the XML that ClickHouse's YAML parser builds. YAML comments are not carried over.";
      name = `${stem}.${r.format === 'xml' ? 'yaml' : 'xml'}`;
    }
  }
  p.innerHTML = `<div class="out-tools">
      <button class="btn${outKind === 'same' ? ' primary' : ''}" id="out-same">${labels[0]}</button>
      <button class="btn${outKind === 'other' ? ' primary' : ''}" id="out-other">${labels[1]}</button>
      <button class="btn" id="out-dl" title="Save as ${esc(name)}">Download</button>
      <button class="btn ghost" id="out-copy">Copy</button>
      ${r.merged ? '' : '<button class="btn ghost" id="out-use">Replace editor</button>'}
      <span class="note">${esc(note)}</span></div><pre class="out" id="out-text"></pre>`;
  const outPre = $('#out-text');
  if (text.length <= HL_LIMIT) outPre.innerHTML = highlight(text, /\.ya?ml$/.test(name) ? 'yaml' : 'xml');
  else outPre.textContent = text;
  $('#out-same').onclick = () => {
    outKind = 'same';
    renderFormatted();
  };
  $('#out-other').onclick = () => {
    outKind = 'other';
    renderFormatted();
  };
  $('#out-dl').onclick = () => download(name, text);
  $('#out-copy').onclick = async (e) => {
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('#out-text'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      e.target.textContent = 'Selected, press Ctrl+C';
    }
    setTimeout(() => {
      e.target.textContent = 'Copy';
    }, 1800);
  };
  const use = $('#out-use');
  if (use)
    use.onclick = () => {
      if (outKind === 'other') {
        f.path = f.path.replace(/\.(xml|conf|ya?ml)$/i, '') + (r.format === 'xml' ? '.yaml' : '.xml');
        f.format = 'auto';
      }
      outKind = 'same';
      commitEdit(state.active, text);
    };
}

function download(name, text, mime) {
  const type = mime || (/\.ya?ml$/.test(name) ? 'application/yaml' : 'application/xml');
  const url = URL.createObjectURL(
    new Blob([text.endsWith('\n') ? text : text + '\n'], { type: `${type};charset=utf-8` }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function share() {
  const { state: st, redacted } = shareableState(state);
  const url = `${location.origin}${location.pathname}#s=${await encodeState(st)}`;
  let copied = true;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    copied = false;
  }
  if (!copied) {
    history.replaceState(null, '', url);
  }
  const note = redacted
    ? ` ${redacted} secret value${redacted === 1 ? ' was' : 's were'} replaced with REDACTED.`
    : ' No secret values found.';
  toast(
    `${copied ? 'Link copied.' : 'Link is in the address bar; copy it from there.'}${note} The files travel in the link itself; nothing is uploaded.`,
  );
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 6000);
}

function selectTab(name) {
  for (const t of els.tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const [k, p] of Object.entries(els.panels)) p.hidden = k !== name;
  store.set('ccv.tab', name);
  if (name === 'upgrade') renderUpgrade();
}

function onKey(e) {
  if (!els.ac.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      ac.sel = (ac.sel + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
      renderAc();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      acceptAc(ac.items[ac.sel]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAc();
      return;
    }
  }
  // Ctrl+Y redo everywhere (browsers only bind it on Windows); Ctrl+Z / Ctrl+Shift+Z are native.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    document.execCommand('redo');
    return;
  }
  if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const ta = els.source,
      s = ta.selectionStart;
    const unit = last && last.format === 'yaml' ? '  ' : '    ';
    editText(unit, s, ta.selectionEnd);
  }
}

// ---------------------------------------------------------------- hover docs and autocomplete

const fmtOfActive = () => {
  const f = activeFile();
  if (f.format && f.format !== 'auto') return f.format;
  return /\.ya?ml$/i.test(f.path) ? 'yaml' : /\.(xml|conf)$/i.test(f.path) ? 'xml' : detectFormat(f.text);
};
let metrics = null;
function textMetrics() {
  if (metrics) return metrics;
  const cs = getComputedStyle(els.source);
  const probe = document.createElement('span');
  probe.style.cssText = `font:${cs.font};position:absolute;visibility:hidden;white-space:pre`;
  probe.textContent = 'M'.repeat(50);
  document.body.append(probe);
  metrics = {
    cw: probe.getBoundingClientRect().width / 50,
    pl: parseFloat(cs.paddingLeft),
    pt: parseFloat(cs.paddingTop),
  };
  probe.remove();
  return metrics;
}
const pxFor = (line, col) => {
  const m = textMetrics();
  return { left: m.pl + col * m.cw - els.source.scrollLeft, top: m.pt + line * LH - els.source.scrollTop };
};

let hoverTimer = null,
  hoverKey = '';
function hideHover(delay = 0) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    els.hovercard.hidden = true;
    hoverKey = '';
  }, delay);
}

// Findings shown on the line under the pointer (same filters as the list).
const lineFindings = (n) =>
  last && last.findings ? last.findings.filter((f) => f.line === n && filter[f.sev] && forActive(f)) : [];
const findingsHtml = (fs) =>
  fs.length
    ? `<div class="hc-findings">${fs.map((f) => `<div class="hc-f ${f.sev}"><span class="sev">${f.sev === 'info' ? 'note' : f.sev}</span><span>${msgHtml(f)}</span></div>`).join('')}</div>`
    : '';

function showCard(html, line, a, key, passive = false) {
  hoverKey = key;
  clearTimeout(hoverTimer);
  els.hovercard.innerHTML = html;
  // A findings-only card has nothing to click, so it lets the pointer through to the lines it covers.
  els.hovercard.classList.toggle('passive', passive);
  els.hovercard.hidden = false;
  const p = pxFor(line + 1, a);
  const wrap = els.source.parentElement.getBoundingClientRect();
  const w = els.hovercard.offsetWidth,
    h = els.hovercard.offsetHeight;
  const top = p.top + h + 4 > wrap.height ? p.top - LH - h - 4 : p.top + 2;
  els.hovercard.style.top = `${Math.max(4, top)}px`;
  els.hovercard.style.left = `${Math.max(4, Math.min(p.left, wrap.width - w - 8))}px`;
}

/** Hover card for line `line` (0-based): the findings on it, if any. */
function showLineFindings(line) {
  const fs = lineFindings(line + 1);
  if (!fs.length) {
    hideHover(250);
    return;
  }
  const key = `f:${line}`;
  if (key === hoverKey && !els.hovercard.hidden) {
    clearTimeout(hoverTimer);
    return;
  }
  const indent = (els.source.value.split('\n')[line] || '').match(/^\s*/)[0].length;
  // Passive unless a message links to another file, which needs the pointer.
  showCard(findingsHtml(fs), line, indent, key, !fs.some(hasLinks));
}

function onHover(e) {
  if (!schema) return;
  const m = textMetrics();
  const r = els.source.getBoundingClientRect();
  const line = Math.floor((e.clientY - r.top + els.source.scrollTop - m.pt) / LH);
  const col = Math.floor((e.clientX - r.left + els.source.scrollLeft - m.pl) / m.cw);
  const text = els.source.value;
  const lines = text.split('\n');
  const lt = lines[line];
  if (lt == null || line < 0) {
    hideHover(250);
    return;
  }
  const info = col >= 0 && col < lt.length ? keyUnder(text, lines, line, col) : null;
  if (!info) {
    showLineFindings(line);
    return;
  }
  const key = `${line}:${info.a}:${info.path}`;
  if (key === hoverKey && !els.hovercard.hidden) {
    clearTimeout(hoverTimer);
    return;
  }
  const d = info.def || {};
  const tier = d.tier ? `<span class="role tier-${d.tier}">${esc(d.tier.replace('_', ' '))}</span>` : '';
  const obs = d.obsolete ? '<span class="role ignored">obsolete</span>' : '';
  showCard(
    `${findingsHtml(lineFindings(line + 1))}<div class="hc-name">${esc(info.name)}${tier}${obs}</div>
    <div class="hc-meta">${esc(info.scope)}${d.t ? ` · ${esc(d.t)}` : ''}${d.d !== '' && d.d != null ? ` · default ${esc(d.d)}` : ''}</div>
    ${d.desc ? `<p>${fmtMsg(d.desc)}</p>` : ''}<a href="${esc(info.url)}" target="_blank" rel="noopener">Documentation</a>`,
    line,
    info.a,
    key,
  );
}

/** The setting whose key is under column `col` of line `line`, with its docs, or null. */
function keyUnder(text, lines, line, col) {
  const lt = lines[line];
  let a = col,
    b = col;
  while (a > 0 && /[\w.-]/.test(lt[a - 1])) a--;
  while (b < lt.length && /[\w.-]/.test(lt[b])) b++;
  const word = lt.slice(a, b);
  if (!/^[A-Za-z_]/.test(word)) return null;
  const lineStart = lines.slice(0, line).reduce((s, l) => s + l.length + 1, 0);
  let path;
  if (fmtOfActive() === 'xml') {
    const close = lt.slice(Math.max(0, a - 2), a) === '</';
    if (lt[a - 1] !== '<' && !close) return null;
    path = contextPath(text, lineStart + a - (close ? 2 : 1), 'xml');
    if (close) path = path.slice(0, -1);
  } else {
    if (!/^\s*["']?\s*:/.test(lt.slice(b))) return null;
    path = contextPath(text, lineStart + lt.match(/^\s*/)[0].length, 'yaml');
  }
  const info = lookup(schema, path, word);
  return info ? { ...info, a, path: path.join('.') } : null;
}

const ac = { items: [], sel: 0, start: 0, end: 0, fmt: 'xml' };
function suggestAt() {
  if (!schema) return;
  const ta = els.source;
  if (ta.selectionStart !== ta.selectionEnd) {
    closeAc();
    return;
  }
  const pos = ta.selectionStart;
  const text = ta.value;
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const fmt = fmtOfActive();
  let prefix, start, path;
  if (fmt === 'xml') {
    const m = /<([A-Za-z_][\w.-]*)?$/.exec(before);
    if (!m) {
      closeAc();
      return;
    }
    prefix = m[1] || '';
    start = pos - prefix.length;
    path = contextPath(text, start - 1, 'xml');
  } else {
    const m = /^(\s*)(-\s+)?([A-Za-z_][\w.-]*)$/.exec(before);
    if (!m) {
      closeAc();
      return;
    }
    prefix = m[3];
    start = pos - prefix.length;
    path = contextPath(text, lineStart + m[1].length, 'yaml');
  }
  const items = complete(schema, path, prefix).filter((x) => x !== prefix);
  if (!items.length) {
    closeAc();
    return;
  }
  Object.assign(ac, { items, sel: 0, start, end: pos, fmt, path });
  renderAc();
  const line = text.slice(0, start).split('\n').length;
  const p = pxFor(line, start - lineStart);
  const wrap = els.source.parentElement.getBoundingClientRect();
  els.ac.hidden = false;
  const h = els.ac.offsetHeight;
  els.ac.style.top = `${p.top + 2 + h > wrap.height ? p.top - LH - h : p.top + 2}px`;
  els.ac.style.left = `${Math.max(4, Math.min(p.left, wrap.width - els.ac.offsetWidth - 8))}px`;
}

function renderAc() {
  els.ac.innerHTML = ac.items
    .map((k, i) => {
      const info = lookup(schema, ac.path, k);
      return `<li role="option" data-k="${esc(k)}" aria-selected="${i === ac.sel}">${esc(k)}${info?.def?.t ? `<span class="t">${esc(info.def.t)}</span>` : ''}</li>`;
    })
    .join('');
  for (const li of els.ac.querySelectorAll('li'))
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acceptAc(li.dataset.k);
    });
  els.ac.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function closeAc() {
  els.ac.hidden = true;
}

function acceptAc(name) {
  const ta = els.source;
  const text = ta.value;
  let insert, caret;
  if (ac.fmt === 'xml') {
    const after = text.slice(ac.end);
    const hasClose = /^[^<\n]*>/.test(after);
    insert = hasClose ? name : `${name}></${name}>`;
    caret = ac.start + (hasClose ? name.length : name.length + 1);
    editText(insert, ac.start, ac.end);
  } else {
    insert = `${name}: `;
    caret = ac.start + insert.length;
    editText(insert, ac.start, ac.end);
  }
  ta.setSelectionRange(caret, caret);
  closeAc();
  activeFile().text = ta.value;
  schedule();
}

init().catch((e) => {
  console.error(e);
  els.panels.findings.innerHTML = `<div class="all-clear">Could not load the settings data (${esc(e.message)}). Serve the site over HTTP, for example with <code>python3 -m http.server</code>, rather than opening the file directly.</div>`;
});
const savedTab = store.get('ccv.tab');
if (savedTab && els.panels[savedTab] && !location.hash) selectTab(savedTab);
