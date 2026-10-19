// Logging: system log tables (mirrors src/Interpreters/SystemLog.cpp) and <logger> (Poco rotation rules).

import { child, textOf } from '../tree.js';
import { ref, SRC } from '../docs.js';
import { LOGGER_LEVELS, SYSTEM_LOGS, SYSTEM_LOG_KEYS, SYSTEM_LOG_TYPES } from './constants.js';
import { typeCheck, unknownChild } from './helpers.js';

/** System log table sections (<query_log> and friends): engine vs. partition/order/ttl, known keys, types. */
export function checkSystemLogs(ctx) {
  const known = new Set(SYSTEM_LOG_KEYS);
  for (const p of ctx.schema.refPaths.server) {
    const parts = p.split('.');
    if (parts.length === 2 && SYSTEM_LOGS.includes(parts[0])) known.add(parts[1]);
  }
  for (const name of SYSTEM_LOGS) {
    const sec = child(ctx.cfg, name);
    if (!sec || sec.attrs.has('remove')) continue;
    const dref = ref.server(name);
    const sref = ref.source(SRC.systemLog, 'SystemLog.cpp');
    if (child(sec, 'engine')) {
      for (const k of ['partition_by', 'ttl', 'order_by', 'storage_policy', 'settings']) {
        const c = child(sec, k);
        if (c)
          ctx.add(
            'error',
            'syslog-engine',
            c,
            `<${name}> sets <engine>, so <${k}> must go inside the engine definition instead; the server refuses to start ("${k} setting doesn't make sense").`,
            [dref, sref],
          );
      }
    }
    for (const c of sec.children) {
      if (!known.has(c.name) && c.name !== 'include') {
        unknownChild(ctx, c, [...known], [dref], { sev: 'info' });
        continue;
      }
      if (SYSTEM_LOG_TYPES[c.name]) typeCheck(ctx, c, SYSTEM_LOG_TYPES[c.name], {}, [dref]);
      if (c.name === 'flush_on_crash' || c.name === 'symbolize' || c.name === 'enable_user_query_log')
        typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [dref]);
    }
    if (name === 'metric_log') {
      const st = child(sec, 'schema_type');
      if (st && textOf(st) && !['wide', 'transposed', 'transposed_with_wide_view', 'bucketed'].includes(textOf(st)))
        ctx.add('error', 'metric-schema', ctx.valueNode(st), `Unknown schema type '${textOf(st)}' for metric_log.`, [
          dref,
          sref,
        ]);
    }
    const mx = textOf(child(sec, 'max_size_rows')),
      rs = textOf(child(sec, 'reserved_size_rows'));
    if (mx && rs && /^\d+$/.test(mx) && /^\d+$/.test(rs) && Number(rs) > Number(mx))
      ctx.add(
        'warning',
        'syslog-sizes',
        child(sec, 'reserved_size_rows'),
        `reserved_size_rows (${rs}) exceeds max_size_rows (${mx}).`,
        [dref],
      );
  }
}

/** Mirrors CombinedRotateStrategy::parseRotation; returns an explanation or null when valid. */
function rotationError(r) {
  if (r === 'never') return null;
  let pos = 0;
  const ws = () => {
    while (pos < r.length && /\s/.test(r[pos])) pos++;
  };
  const size = () => {
    const save = pos;
    ws();
    let n = '';
    while (pos < r.length && /\d/.test(r[pos])) n += r[pos++];
    ws();
    let unit = '';
    while (pos < r.length && /[A-Za-z]/.test(r[pos])) unit += r[pos++];
    ws();
    const ok =
      Number(n) > 0 && (['K', 'M', 'G'].includes(unit) || (unit === '' && (pos === r.length || r[pos] === ',')));
    if (!ok) {
      pos = save;
      return { ok: false, unit };
    }
    ws();
    if (r[pos] === ',') pos++;
    return { ok: true };
  };
  const interval = () => {
    const save = pos;
    ws();
    while (pos < r.length && /\d/.test(r[pos])) pos++;
    ws();
    let unit = '';
    while (pos < r.length && /[A-Za-z]/.test(r[pos])) unit += r[pos++];
    if (
      ![
        'daily',
        'weekly',
        'monthly',
        'seconds',
        'milliseconds',
        'minutes',
        'hours',
        'days',
        'weeks',
        'months',
      ].includes(unit)
    ) {
      pos = save;
      return false;
    }
    ws();
    if (r[pos] === ',') pos++;
    return true;
  };
  const time = () => {
    const c = r.indexOf(':', pos);
    if (c < 0) return false;
    const comma = r.indexOf(',', c + 1);
    pos = comma < 0 ? r.length : comma + 1;
    return true;
  };
  let sz = size();
  const iv = interval();
  const tm = time();
  if (!sz.ok) {
    const s2 = size();
    if (s2.ok) sz = s2;
  }
  ws();
  if ((!sz.ok && !iv && !tm) || pos !== r.length) {
    const unit = /^\s*\d+\s*([A-Za-z]+)/.exec(r)?.[1];
    if (unit && !['K', 'M', 'G'].includes(unit) && /^[kmgt]i?b?$|^[KMGT]i?B$|^[KMGT]i$/i.test(unit))
      return `uses the unit '${unit}'; log rotation sizes accept only K, M or G (uppercase, no "B"), e.g. 100M.`;
    return 'is not a valid rotation: use <size>[K|M|G] (e.g. 100M), an interval (daily, weekly, monthly, <n> minutes|hours|days|weeks|months), [<size>,]<interval>, a time ([day,][hh]:mm) or never.';
  }
  return null;
}

/** <logger>: level names, size/rotation and count as Poco parses them, console and syslog keys. */
export function checkLogger(ctx) {
  const lg = child(ctx.cfg, 'logger');
  if (!lg || ctx.hasSubst(lg)) return;
  const dref = ref.server('logger');
  const kids = new Set([
    'levels',
    'formatting',
    'syslog',
    'errorlog_level',
    'flush',
    'rotateOnOpen',
    'json',
    'console_format_level',
  ]);
  for (const s of Object.values(ctx.schema.serverWithPath))
    if (s.path.startsWith('logger.')) kids.add(s.path.split('.')[1]);
  for (const p of ctx.schema.refPaths.server) if (p.startsWith('logger.')) kids.add(p.split('.')[1]);
  for (const c of lg.children) {
    if (!kids.has(c.name)) {
      unknownChild(ctx, c, [...kids], [dref]);
      continue;
    }
    if (/(^level$|_level$)/.test(c.name) && textOf(c) && !LOGGER_LEVELS.includes(textOf(c).toLowerCase()))
      ctx.add(
        'error',
        'log-level',
        ctx.valueNode(c),
        `'${textOf(c)}' is not a valid log level; allowed: ${LOGGER_LEVELS.join(', ')}.`,
        [dref],
      );
    else if (/(^level$|_level$)/.test(c.name) && textOf(c) && textOf(c) !== textOf(c).toLowerCase())
      ctx.add('info', 'log-level-case', ctx.valueNode(c), `Log level '${textOf(c)}' is usually written in lowercase.`, [
        dref,
      ]);
  }
  // Rotation and purge values are handed to Poco's FileChannel as raw strings and parsed there at startup.
  const rot = child(lg, 'rotation') || child(lg, 'size');
  if (rot && textOf(rot) && !ctx.hasSubst(rot)) {
    const err = rotationError(textOf(rot).trim());
    if (err)
      ctx.add(
        'error',
        'logger-rotation',
        ctx.valueNode(rot),
        `<${rot.name}> '${textOf(rot).trim()}' ${err} The server fails to start ("Invalid rotation format").`,
        [dref, ref.source('base/poco/Foundation/include/Poco/CombinedRotateStrategy.h', 'CombinedRotateStrategy.h')],
      );
  }
  if (child(lg, 'rotation') && child(lg, 'size'))
    ctx.add('info', 'logger-size-ignored', child(lg, 'size'), '<size> is ignored because <rotation> is set.', [
      dref,
      ref.source('src/Loggers/Loggers.cpp', 'Loggers.cpp'),
    ]);
  const cnt = child(lg, 'count');
  if (cnt && textOf(cnt) != null && !ctx.hasSubst(cnt)) {
    const v = textOf(cnt).trim();
    if (/^none$/i.test(v) || v === '')
      ctx.add(
        'warning',
        'logger-count-none',
        ctx.valueNode(cnt),
        `<count> '${v || '(empty)'}' disables purging: rotated log files are never deleted.`,
        [dref],
      );
    else if (!/^\s*[1-9]\d*/.test(v))
      ctx.add(
        'error',
        'logger-count',
        ctx.valueNode(cnt),
        `<count> '${v}' must start with a positive number; Poco reads leading digits and rejects 0 ("Zero is not valid purge age"), so the server fails to start.`,
        [dref, ref.source('base/poco/Foundation/src/FileChannel.cpp', 'FileChannel.cpp')],
      );
    else if (!/^\d+$/.test(v))
      ctx.add(
        'warning',
        'logger-count-trailing',
        ctx.valueNode(cnt),
        `<count> '${v}': only the leading number is used.`,
        [dref],
      );
  }
  const lv = child(lg, 'levels');
  if (lv) {
    for (const l of lv.children) {
      if (l.name !== 'logger') continue;
      const lvl = textOf(child(l, 'level'));
      if (!child(l, 'name')) ctx.add('error', 'logger-name', l, '<levels><logger> needs a <name>.', [dref]);
      if (lvl && !LOGGER_LEVELS.includes(lvl.toLowerCase()))
        ctx.add('error', 'log-level', child(l, 'level'), `'${lvl}' is not a valid log level.`, [dref]);
    }
  }
  if (!child(lg, 'log') && !child(lg, 'console') && ctx.mode !== 'users')
    ctx.add(
      'info',
      'logger-nofile',
      lg,
      '<logger> has no <log> file; output goes to the console only when <console> is enabled or the server runs in the foreground.',
      [dref],
    );
}
