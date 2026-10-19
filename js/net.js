// Address syntax checks for host / IP values in configs.

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isIPv4(v) {
  const p = v.split('.');
  return p.length === 4 && p.every((x) => OCTET.test(x));
}

export function isIPv6(v) {
  let s = v.replace(/^\[(.*)\]$/, '$1').replace(/%[\w.\-]+$/, '');   // brackets and zone id
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || !s.includes(':')) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = (h) => (h === '' ? [] : h.split(':'));
  const parts = [...groups(halves[0]), ...(halves.length === 2 ? groups(halves[1]) : [])];
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i];
    if (i === parts.length - 1 && g.includes('.')) { if (!isIPv4(g)) return false; count += 2; continue; }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return false;
    count++;
  }
  return halves.length === 2 ? count < 8 : count === 8;
}

const LABEL = /^(?!-)[A-Za-z0-9_-]{1,63}(?<!-)$/;
export const isHostname = (v) => v.length <= 253 && v.replace(/\.$/, '').split('.').every((l) => LABEL.test(l));

/**
 * Classify a host value. Returns { ok: true, kind } or { ok: false, msg }.
 * allowHostname: whether a DNS name is acceptable here (true for most host settings).
 */
export function checkHost(v, { allowHostname = true } = {}) {
  if (isIPv4(v)) return { ok: true, kind: 'ipv4' };
  if (isIPv6(v)) return { ok: true, kind: 'ipv6' };
  if (/^[\d.]+$/.test(v)) {
    const p = v.split('.');
    if (p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255))
      return { ok: false, msg: `'${v}' has a leading zero in an IPv4 part; some parsers read that as octal (010 = 8). Write it without leading zeros.` };
    const bad = p.find((x) => x !== '' && !OCTET.test(x));
    return { ok: false, msg: bad != null && Number(bad) > 255
      ? `'${v}' is not a valid IPv4 address: ${bad} is out of range (each part must be 0-255).`
      : `'${v}' is not a valid IPv4 address: expected four numbers 0-255 separated by dots (e.g. 0.0.0.0), got ${p.length} part${p.length === 1 ? '' : 's'}. Some resolvers expand shorthand forms and others treat them as host names, so write the full address.` };
  }
  if (/^[0-9A-Fa-f:.%\[\]]+$/.test(v) && v.includes(':')) {
    if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v) || /^\[.*\]:\d+$/.test(v)) return { ok: false, msg: `'${v}' includes a port. Give only the address here; ports are separate settings.` };
    return { ok: false, msg: `'${v}' is not a valid IPv6 address.` };
  }
  if (/^[^:]+:\d+$/.test(v)) return { ok: false, msg: `'${v}' includes a port. Give only the host here; ports are separate settings.` };
  if (!allowHostname) return { ok: false, msg: `'${v}' is not an IP address.` };
  if (isHostname(v)) return { ok: true, kind: 'hostname' };
  return { ok: false, msg: `'${v}' is neither a valid IP address nor a valid host name (letters, digits, '-', '.' only; labels up to 63 characters).` };
}
