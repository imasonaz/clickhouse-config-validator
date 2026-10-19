// Value checks that mirror how ClickHouse parses configuration values.
//
// Two parsers matter:
//  * "setting" — ServerSettings / CoordinationSettings / MergeTreeSettings / profile settings are read
//    with config.getString() and parsed by SettingField* (src/Core/SettingsFieldsConversionHelpers.cpp):
//    integers accept an optional size suffix (k/K/M/G/T, optionally followed by "i"), bools accept only
//    0/1/true/false (case-insensitive), floats must be finite.
//  * "poco" — keys read directly via Poco::Util::AbstractConfiguration (getInt/getBool/getUInt64):
//    getBool accepts true/false/yes/no/on/off (case-insensitive) or an integer; getInt accepts decimal
//    or 0x-prefixed hex.

import { ref, SRC } from './docs.js';

const INT_RANGES = {
  UInt64: [0n, 18446744073709551615n],
  NonZeroUInt64: [1n, 18446744073709551615n],
  Milliseconds: [0n, 18446744073709551615n],
  UInt32: [0n, 4294967295n],
  Int32: [-2147483648n, 2147483647n],
  Int64: [-9223372036854775808n, 9223372036854775807n],
  UInt16: [0n, 65535n],
  Port: [0n, 65535n],
  UInt64Auto: [0n, 18446744073709551615n],
  MaxThreads: [0n, 18446744073709551615n],
};
const SUFFIX = {
  k: [1000n, 10n],
  K: [1000n, 10n],
  M: [1000000n, 20n],
  G: [1000000000n, 30n],
  T: [1000000000000n, 40n],
};

const sizeSuffixRef = () => ref.source(SRC.sizeSuffix, 'ReadHelpers.h (readTextWithSizeSuffix)');
const settingParseRef = () => ref.source(SRC.settingsParse, 'SettingsFieldsConversionHelpers.cpp');

/** Parse an integer the way readTextWithSizeSuffix does. Returns BigInt or an error string. */
export function parseSettingInt(s) {
  const m = /^([+-]?)(\d+)(?:([kKMGT])(i?))?$/.exec(s);
  if (!m) {
    if (
      /^[+-]?\d+(\.\d+)?\s*([kKMGT]i?)?[bB]$/.test(s) ||
      /^[+-]?\d+\s*[kKMGT]i?[bB]?$/.test(s) ||
      /^[+-]?\d+\s+[kKMGT]/.test(s)
    )
      return `'${s}' is not a valid size: use a bare suffix such as 10G or 10Gi (no "B", no space)`;
    if (/^[+-]?\d*\.\d+/.test(s)) return `'${s}' is not an integer`;
    if (/^0x/i.test(s)) return `'${s}': hex literals are not accepted by ClickHouse setting parsers`;
    return `'${s}' is not an integer`;
  }
  let v = BigInt(m[2]);
  if (m[3]) {
    const [dec, pow] = SUFFIX[m[3]];
    v = m[4] ? v << pow : v * dec;
  }
  return m[1] === '-' ? -v : v;
}

function parsePocoInt(s) {
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|\d+)\s*$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[2]);
  return m[1] === '-' ? -v : v;
}

export const POCO_BOOL = /^(true|false|yes|no|on|off|[+-]?\d+)$/i;
export const SETTING_BOOL = /^(0|1|true|false)$/i;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Check `raw` against a ClickHouse setting type.
 * Returns { sev, msg, refs } or null when the value is acceptable.
 */
export function checkValue(type, raw, { parser = 'setting', enums = {} } = {}) {
  if (raw == null) raw = '';
  const out = (sev, msg, refs = []) => ({ sev, msg, refs });
  // Surrounding whitespace is reported separately (the 'whitespace' finding), so the trimmed value is checked here.
  const v = raw.trim();

  switch (type) {
    case 'String':
    case 'Timezone':
    case 'Map':
      return null;
    case 'Bool': {
      if (parser === 'poco') {
        if (!POCO_BOOL.test(v))
          return out('error', `'${v}' is not a boolean (expected true/false, yes/no, on/off or a number)`);
        return null;
      }
      if (!SETTING_BOOL.test(v)) {
        const hint = /^(yes|no|on|off)$/i.test(v)
          ? ` "${v}" is accepted by some Poco-read keys but not by ClickHouse settings.`
          : '';
        return out('error', `'${v}' is not a valid Bool: use true/false or 1/0.${hint}`, [settingParseRef()]);
      }
      return null;
    }
    case 'BoolAuto':
      if (v.toLowerCase() === 'auto' || SETTING_BOOL.test(v)) return null;
      return out('error', `'${v}' is not valid: use auto, true/false or 1/0`, [settingParseRef()]);
    case 'Float':
    case 'Double':
    case 'Seconds':
    case 'FloatAuto': {
      if (type === 'FloatAuto' && v.toLowerCase() === 'auto') return null;
      if (!FLOAT.test(v)) {
        if (/^(inf|nan|-inf|\+inf)$/i.test(v))
          return out('error', `'${v}': floating point settings must be finite`, [settingParseRef()]);
        return out('error', `'${v}' is not a number`, [settingParseRef()]);
      }
      return null;
    }
    case 'UInt64':
    case 'UInt32':
    case 'Int32':
    case 'Int64':
    case 'NonZeroUInt64':
    case 'Milliseconds':
    case 'UInt16':
    case 'Port':
    case 'UInt64Auto':
    case 'MaxThreads': {
      if ((type === 'UInt64Auto' || type === 'MaxThreads') && /^auto(\(\d+\))?$/i.test(v)) return null;
      if (v === '') return out('error', `Empty value for ${type === 'Port' ? 'a port' : `a ${type} setting`}`);
      let n;
      if (parser === 'poco') {
        n = parsePocoInt(v);
        if (n === null) return out('error', `'${v}' is not an integer`);
      } else {
        n = parseSettingInt(v);
        if (typeof n === 'string') return out('error', n, [sizeSuffixRef()]);
      }
      const [lo, hi] = INT_RANGES[type];
      if (n < lo || n > hi) {
        if (type === 'NonZeroUInt64' && n === 0n)
          return out('error', 'Value must be greater than zero (NonZeroUInt64)');
        if (n < 0n && lo === 0n) return out('error', `'${v}' is negative but the setting is unsigned (${type})`);
        return out('error', `'${v}' is out of range for ${type === 'Port' ? 'a TCP port (0-65535)' : type}`);
      }
      return null;
    }
    default: {
      const e = enums[type];
      if (!e) return null; // enum we don't know the values of: accept
      const vals = e.values;
      const items = e.multi
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [v];
      for (const it of items) {
        if (vals.includes(it)) continue;
        const ci = vals.find((x) => x.toLowerCase() === it.toLowerCase());
        if (ci)
          return out('warning', `'${it}' differs in case from the allowed value '${ci}'`, [
            ref.source(SRC.enums, 'SettingsEnums.cpp'),
          ]);
        return out(
          'error',
          `'${it}' is not an allowed value. Allowed: ${vals
            .filter((x) => x !== '')
            .map((x) => `'${x}'`)
            .join(', ')}`,
          [ref.source(SRC.enums, 'SettingsEnums.cpp')],
        );
      }
      return null;
    }
  }
}

/** Levenshtein distance (small inputs). */
export function lev(a, b) {
  if (a === b) return 0;
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Best "did you mean" candidate or null. */
export function suggest(name, candidates) {
  const lname = name.toLowerCase();
  let best = null,
    bestD = Infinity;
  for (const c of candidates) {
    if (c.toLowerCase() === lname) return { name: c, d: 0, caseOnly: true };
    if (Math.abs(c.length - name.length) > 4) continue;
    const d = lev(lname, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const limit = name.length <= 4 ? 1 : name.length <= 8 ? 2 : 3;
  return best && bestD <= limit ? { name: best, d: bestD } : null;
}
