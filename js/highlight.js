// Syntax colouring for the editor backdrop. Returns HTML for a <pre> drawn behind the transparent textarea,
// so it must reproduce the text exactly: every character is emitted once, only wrapped in spans.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, s) => (s ? `<span class="hl-${cls}">${esc(s)}</span>` : '');

const XML_TOKEN = /(<!--[\s\S]*?(?:-->|$))|(<!\[CDATA\[[\s\S]*?(?:\]\]>|$))|(<[?!][\s\S]*?(?:>|$))|(<\/?)([\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)(\/?>)?|([^<]+)|(<)/g;
const XML_ATTR = /([\w:.@-]+)(\s*=\s*)("[^"]*"?|'[^']*'?)|([^"'\w]+|[\s\S])/g;
const SUBST_ATTRS = new Set(['incl', 'from_env', 'from_zk', 'replace', 'remove', 'optional']);

function xml(text) {
  let out = '';
  XML_TOKEN.lastIndex = 0;
  for (let m; (m = XML_TOKEN.exec(text)) && m[0] !== '';) {
    if (m[1]) out += span('com', m[1]);
    else if (m[2]) out += span('str', m[2]);
    else if (m[3]) out += span('meta', m[3]);
    else if (m[4]) {
      out += span('punc', m[4]) + span('tag', m[5]);
      XML_ATTR.lastIndex = 0;
      for (let a; (a = XML_ATTR.exec(m[6])) && a[0] !== '';) {
        out += a[1] ? span(SUBST_ATTRS.has(a[1]) ? 'kw' : 'attr', a[1]) + esc(a[2]) + span('str', a[3]) : esc(a[0]);
      }
      out += span('punc', m[7] || '');
    } else if (m[8]) out += /^\s*-?\d+(\.\d+)?\s*$/.test(m[8]) || /^\s*(true|false)\s*$/.test(m[8]) ? span('num', m[8]) : esc(m[8]);
    else out += esc(m[0]);
  }
  return out;
}

// Plain YAML scalars: quoted strings, numbers, booleans and nulls, anchors/aliases and tags.
function yamlValue(v) {
  const m = /^(\s*)(.*?)(\s*)$/.exec(v);
  const [, pre, body, post] = m;
  let cls = null;
  if (/^(["']).*\1$/.test(body)) cls = 'str';
  else if (/^[-+]?(\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/.test(body) || /^(true|false|null|~|yes|no|on|off)$/i.test(body)) cls = 'num';
  else if (/^[&*!][^\s]*$/.test(body)) cls = 'meta';
  else if (/^[|>][-+]?\d*$/.test(body)) cls = 'punc';
  return esc(pre) + (cls ? span(cls, body) : esc(body)) + esc(post);
}

// Split off a trailing comment: '#' at line start or after whitespace, outside quotes.
function splitComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[{,-]/.test(line[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return [line.slice(0, i), line.slice(i)];
  }
  return [line, ''];
}

function yaml(text) {
  let block = -1; // indentation of an open block scalar (| or >); its lines are plain text
  return text.split('\n').map((line) => {
    const indent = /^\s*/.exec(line)[0].length;
    if (block >= 0) {
      if (line.trim() === '' || indent > block) return esc(line);
      block = -1;
    }
    if (/^(---|\.\.\.)\s*$/.test(line) || /^%/.test(line)) return span('meta', line);
    const [code, comment] = splitComment(line);
    let out = '';
    let rest = code;
    const dash = /^(\s*)((?:- +)*)/.exec(rest);
    out += esc(dash[1]) + span('punc', dash[2]);
    rest = rest.slice(dash[0].length);
    const key = /^("[^"]*"|'[^']*'|[^\s#'"[{][^#]*?)(\s*)(:)(?=\s|$)/.exec(rest);
    if (key) {
      out += span(key[1].startsWith('@') ? 'attr' : 'key', key[1]) + esc(key[2]) + span('punc', key[3]);
      rest = rest.slice(key[0].length);
      if (/^\s*[|>][-+]?\d*\s*$/.test(rest)) block = indent + dash[2].length;
    } else if (/^\s*[|>][-+]?\d*\s*$/.test(rest)) block = indent;
    return out + yamlValue(rest) + span('com', comment);
  }).join('\n');
}

export function highlight(text, format) {
  return format === 'yaml' ? yaml(text) : xml(text);
}
