// Shareable links: the file set is deflated into the URL fragment (never sent to a server), after secret values
// are replaced so a link can be pasted into a ticket or chat.

const SECRET_KEYS = ['password', 'password_sha256_hex', 'password_double_sha1_hex', 'secret', 'secret_access_key', 'access_key_id',
  'identity', 'superdigest', 'key', 'key_hex', 'private_key', 'privateKeyPassphrase', 'token', 'access_token', 'account_key',
  'connection_string', 'client_secret', 'bind_password', 'server_side_encryption_customer_key_base64'];
const SECRET_NAME = new RegExp(`^(${SECRET_KEYS.join('|')})(\\[\\d+\\])?$`, 'i');
const SECRET_ENV = /pass|secret|token|key|credential|auth/i;

const mask = (name, v) => (/_hex$/i.test(name) && /^[0-9a-f]+$/i.test(v.trim()) ? '0'.repeat(v.trim().length) : 'REDACTED');

/** Replace secret values in XML or YAML text. Returns { text, count }. */
export function redact(text) {
  let count = 0;
  // XML leaf elements, keeping attributes and surrounding whitespace.
  let out = text.replace(/<([A-Za-z_][\w.\-]*)(\s[^<>]*?)?>([^<]*)<\/\1\s*>/g, (m, name, attrs = '', val) => {
    if (!SECRET_NAME.test(name) || !val.trim()) return m;
    count++;
    return `<${name}${attrs}>${val.replace(val.trim(), mask(name, val))}</${name}>`;
  });
  // YAML block scalars ("secret: |" followed by more-indented lines).
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)(["']?)([A-Za-z_][\w.\-]*)\2\s*:\s*[|>][+-]?\d*\s*$/.exec(lines[i]);
    if (!m || !SECRET_NAME.test(m[3])) continue;
    const ind = lines[i].match(/^\s*/)[0].length;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].match(/^\s*/)[0].length > ind)) j++;
    while (j > i + 1 && lines[j - 1].trim() === '') j--;
    if (j > i + 1) { lines.splice(i, j - i, `${m[1]}${m[2]}${m[3]}${m[2]}: "REDACTED"`); count++; }
  }
  out = lines.join('\n');
  // YAML "key: value" scalars.
  out = out.replace(/^(\s*(?:-\s+)?)(["']?)([A-Za-z_][\w.\-]*)\2(\s*:[ \t]+)(.+?)\s*$/gm, (m, ind, q, name, sep, val) => {
    const unq = val.replace(/^(["'])(.*)\1$/, '$2');
    if (!SECRET_NAME.test(name) || /^[|>&*#]/.test(val) || unq === 'REDACTED') return m;
    count++;
    return `${ind}${q}${name}${q}${sep}${JSON.stringify(mask(name, unq))}`;
  });
  return { text: out, count };
}

export function redactSubstitutions(text) {
  let count = 0;
  const out = (text || '').split('\n').map((l) => {
    const i = l.indexOf('=');
    if (i < 1 || !SECRET_ENV.test(l.slice(0, i))) return l;
    count++;
    return `${l.slice(0, i)}=REDACTED`;
  }).join('\n');
  return { text: out, count };
}

const b64url = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeState(obj) {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('deflate-raw')));
}

export async function decodeState(s) {
  return JSON.parse(new TextDecoder().decode(await pipe(unb64url(s), new DecompressionStream('deflate-raw'))));
}

/** Build the shareable state, redacting unless includeSecrets. Returns { state, redacted }. */
export function shareableState(state, { includeSecrets = false } = {}) {
  let redacted = 0;
  const files = state.files.map((f) => {
    if (includeSecrets) return { path: f.path, text: f.text, format: f.format };
    const r = redact(f.text);
    redacted += r.count;
    return { path: f.path, text: r.text, format: f.format };
  });
  let subst = state.subst;
  if (!includeSecrets) { const r = redactSubstitutions(subst); subst = r.text; redacted += r.count; }
  return { state: { v: 1, files, subst, version: state.version, view: state.view, mainPath: state.mainPath, active: state.active }, redacted };
}
