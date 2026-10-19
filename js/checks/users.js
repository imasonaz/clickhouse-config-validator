// users.xml content: profiles, users, quotas and constraints (rules from src/Access/UsersConfigParser.cpp).

import { child, childrenNamed, textOf } from '../tree.js';
import { ref, SRC } from '../docs.js';
import { suggest } from '../types.js';
import { USER_AUTH_KEYS, USER_KEYS } from './constants.js';
import { isTrue, lifecycle, removedSetting, typeCheck, unknownChild, validIpOrCidr, whereValid } from './helpers.js';

/** users.xml sections: <profiles> (settings and constraints), <users> (auth, networks, grants) and <quotas>. */
export function checkUsersFile(ctx) {
  const { cfg, schema, add } = ctx;
  const profilesEl = child(cfg, 'profiles');
  const usersEl = child(cfg, 'users');
  const quotasEl = child(cfg, 'quotas');
  const profileNames = new Set(profilesEl ? profilesEl.children.map((c) => c.name) : []);
  const quotaNames = new Set(quotasEl ? quotasEl.children.map((c) => c.name) : []);
  const customPrefixes = (textOf(child(cfg, 'custom_settings_prefixes')) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sessionNames = Object.keys(schema.session);
  const uref = ref.source(SRC.usersParser, 'UsersConfigParser.cpp');

  const checkSettingName = (n, scope) => {
    const name = n.name;
    const real = schema.session[name] ? name : schema.sessionAliases[name];
    if (real) return { def: schema.session[real], name: real };
    if (customPrefixes.some((p) => name.startsWith(p))) return { custom: true };
    return null;
  };

  if (profilesEl) {
    for (const prof of profilesEl.children) {
      if (prof.name === 'include') continue;
      for (const s of prof.children) {
        if (s.name === 'include') continue;
        if (s.name === 'profile') {
          const parent = textOf(s);
          if (parent && !profileNames.has(parent))
            add(
              'warning',
              'profile-parent',
              ctx.valueNode(s),
              `Parent profile '${parent}' is not defined in this file. ClickHouse fails with "Parent profile '${parent}' was not found" unless another users.d file defines it.`,
              [uref],
            );
          continue;
        }
        if (s.name === 'constraints' || s.name.startsWith('constraints[')) {
          checkConstraints(ctx, s, customPrefixes);
          continue;
        }
        const r = checkSettingName(s, 'session');
        if (!r) {
          if (
            removedSetting(ctx, 'session', s, 'setting', 'loading the users config fails with UNKNOWN_SETTING', [
              ref.session(s.name),
              uref,
            ])
          )
            continue;
          const sug = suggest(s.name, sessionNames);
          const isServer = schema.server[s.name] && !schema.serverProfileAllowlist.includes(s.name);
          const loc = sug || isServer ? null : whereValid(ctx, s);
          add(
            'error',
            'unknown-setting',
            s,
            `Unknown setting <${s.name}> in profile '${prof.name}'${sug ? `; did you mean <${sug.name}>?` : '.'}${isServer ? ' It is a server setting: move it to the top level of config.xml.' : loc ? loc.msg : ''} Loading the users config fails with UNKNOWN_SETTING.`,
            [isServer ? ref.server(s.name) : ref.session(sug ? sug.name : s.name), uref, ...(loc ? loc.refs : [])],
            {
              fix: sug
                ? { kind: 'rename', to: sug.name }
                : isServer
                  ? { kind: 'move', to: [''] }
                  : loc
                    ? { kind: 'move', to: loc.parents }
                    : undefined,
            },
          );
          continue;
        }
        if (r.custom) continue;
        ctx.recognized.push({
          scope: `profile ${prof.name}`,
          name: r.name,
          type: r.def.t,
          def: r.def.d,
          value: textOf(s) ?? '',
          line: s.line,
          file: s.textFile || s.file,
          url: ref.session(r.name).url,
          desc: r.def.desc,
        });
        lifecycle(ctx, s, 'setting', r.name, r.def, ref.session(r.name), 'profile');
        if (r.name !== s.name)
          add('info', 'alias', s, `<${s.name}> is an alias of <${r.name}>.`, [ref.session(r.name)]);
        typeCheck(ctx, s, r.def.t, {}, [ref.session(r.name)]);
      }
    }
  }

  if (usersEl) {
    for (const u of usersEl.children) {
      if (u.name === 'include') continue;
      const keys = u.children.map((c) => c.name);
      const auth = USER_AUTH_KEYS.filter((k) => keys.includes(k));
      const hasAuthMethods = keys.includes('auth_methods');
      if (hasAuthMethods && auth.length)
        add(
          'error',
          'auth-both',
          u,
          `User '${u.name}' sets both <auth_methods> and <${auth[0]}>; use one or the other.`,
          [ref.users('multiple-authentication-methods', 'Multiple authentication methods'), uref],
        );
      if (auth.length > 1)
        add(
          'error',
          'auth-multi',
          child(u, auth[1]),
          `User '${u.name}' has several authentication methods (${auth.join(', ')}); specify exactly one (or use <auth_methods>).`,
          [ref.users('user-namepassword', 'user_name/password'), uref],
        );
      if (!auth.length && !hasAuthMethods && !u.attrs.has('incl') && !u.attrs.has('remove'))
        add(
          'info',
          'auth-none',
          u,
          `User '${u.name}' has no authentication method here. Fine for a users.d fragment that only overrides other fields; otherwise loading fails ("At least one authentication type … must be specified").`,
          [uref],
        );
      for (const c of u.children) {
        if (!USER_KEYS.includes(c.name) && c.name !== 'include')
          unknownChild(ctx, c, USER_KEYS, [ref.users()], { sev: 'warning', what: `user property in '${u.name}'` });
      }
      const sha = child(u, 'password_sha256_hex');
      if (sha && textOf(sha) && !ctx.hasSubst(sha) && !/^[0-9a-fA-F]{64}$/.test(textOf(sha)))
        add(
          'error',
          'sha256-len',
          ctx.valueNode(sha),
          `password_sha256_hex must be 64 hex characters (32 bytes); got ${textOf(sha).length}.`,
          [ref.users('user-namepassword', 'password_sha256_hex'), ref.source(SRC.authData, 'AuthenticationData.cpp')],
        );
      const dsha = child(u, 'password_double_sha1_hex');
      if (dsha && textOf(dsha) && !ctx.hasSubst(dsha) && !/^[0-9a-fA-F]{40}$/.test(textOf(dsha)))
        add(
          'error',
          'dsha1-len',
          ctx.valueNode(dsha),
          `password_double_sha1_hex must be 40 hex characters (20 bytes); got ${textOf(dsha).length}.`,
          [ref.users('user-namepassword'), ref.source(SRC.authData, 'AuthenticationData.cpp')],
        );
      const pw = child(u, 'password');
      const nets = child(u, 'networks');
      const openNet =
        nets &&
        nets.children.some(
          (c) => c.name.startsWith('ip') && ['::/0', '0.0.0.0/0', '::', '0.0.0.0'].includes(textOf(c)),
        );
      if (pw && !ctx.hasSubst(pw) && textOf(pw))
        add(
          'info',
          'plaintext-password',
          pw,
          `User '${u.name}' has a plaintext <password>. The docs recommend <password_sha256_hex>.`,
          [ref.users('user-namepassword', 'user_name/password')],
        );
      if ((child(u, 'no_password') || (pw && !ctx.hasSubst(pw) && !textOf(pw))) && (openNet || !nets))
        add(
          'warning',
          'open-user',
          u,
          `User '${u.name}' has no password${openNet ? ' and accepts connections from any address' : ''}. Restrict <networks> or set a password.`,
          [ref.users('user-namenetworks', 'user_name/networks')],
        );
      if (nets) {
        for (const c of nets.children) {
          if (c.name === 'include') continue;
          if (!c.name.startsWith('ip') && !c.name.startsWith('host'))
            add(
              'error',
              'networks-key',
              c,
              `Unknown address pattern type <${c.name}> in networks; use <ip>, <host> or <host_regexp>.`,
              [ref.users('user-namenetworks', 'user_name/networks'), uref],
            );
          else if (c.name === 'ip' && textOf(c) && !validIpOrCidr(textOf(c)))
            add('error', 'networks-ip', ctx.valueNode(c), `'${textOf(c)}' is not a valid IP address or subnet.`, [
              ref.users('user-namenetworks', 'user_name/networks'),
            ]);
          else if (c.name === 'host_regexp' && textOf(c)) {
            try {
              new RegExp(textOf(c));
            } catch {
              add(
                'warning',
                'networks-regexp',
                ctx.valueNode(c),
                `host_regexp '${textOf(c)}' does not compile as a regular expression.`,
                [ref.users('user-namenetworks')],
              );
            }
          }
        }
      }
      const pr = child(u, 'profile');
      if (pr && textOf(pr) && profilesEl && !profileNames.has(textOf(pr)))
        add(
          'warning',
          'user-profile',
          ctx.valueNode(pr),
          `Profile '${textOf(pr)}' is not defined in this file ("Profile ${textOf(pr)} was not found" unless defined elsewhere).`,
          [ref.users('user-nameprofile', 'user_name/profile'), uref],
        );
      const qu = child(u, 'quota');
      if (qu && textOf(qu) && quotasEl && !quotaNames.has(textOf(qu)))
        add('warning', 'user-quota', ctx.valueNode(qu), `Quota '${textOf(qu)}' is not defined in this file.`, [
          ref.users('user-namequota', 'user_name/quota'),
        ]);
      if (
        child(u, 'grants') &&
        [
          'allow_databases',
          'databases',
          'allow_dictionaries',
          'access_management',
          'named_collection_control',
          'named_collection_admin',
          'show_named_collections_secrets',
        ].some((k) => child(u, k) && (k.startsWith('allow') || k === 'databases' || isTrue(textOf(child(u, k)))))
      )
        add(
          'error',
          'grants-conflict',
          child(u, 'grants'),
          "Any other access control settings can't be specified with <grants>.",
          [ref.users('grants-user-setting', 'grants'), uref],
        );
      for (const b of [
        'access_management',
        'named_collection_control',
        'show_named_collections',
        'show_named_collections_secrets',
      ]) {
        const n = child(u, b);
        if (n) typeCheck(ctx, n, 'Bool', { parser: 'poco' }, [ref.users(`${b}-user-setting`, b)]);
      }
    }
  }

  if (quotasEl) {
    const qkeys = [
      'queries',
      'query_selects',
      'query_inserts',
      'errors',
      'result_rows',
      'result_bytes',
      'read_rows',
      'read_bytes',
      'execution_time',
      'written_bytes',
      'failed_sequential_authentications',
      'queries_per_normalized_hash',
    ];
    for (const q of quotasEl.children) {
      for (const iv of childrenNamed(q, 'interval')) {
        const d = child(iv, 'duration');
        if (!d) add('error', 'quota-duration', iv, `Quota '${q.name}' interval has no <duration>.`, [ref.users()]);
        for (const c of iv.children) {
          if (c.name === 'duration') typeCheck(ctx, c, 'UInt64', { parser: 'poco' }, [ref.users()]);
          else if (c.name === 'randomize') typeCheck(ctx, c, 'Bool', { parser: 'poco' }, [ref.users()]);
          else if (qkeys.includes(c.name)) {
            if (textOf(c) && !/^\d+(\.\d+)?$/.test(textOf(c)))
              add('error', 'quota-value', ctx.valueNode(c), `<${c.name}> must be a number.`, [ref.users()]);
          } else unknownChild(ctx, c, [...qkeys, 'duration', 'randomize'], [ref.users()], { what: 'quota limit' });
        }
      }
    }
  }
}

function checkConstraints(ctx, cons, customPrefixes) {
  const { schema, add } = ctx;
  const kinds = ['min', 'max', 'readonly', 'const', 'changeable_in_readonly', 'disallowed'];
  for (const s of cons.children) {
    const name = s.name;
    let def = schema.session[name] || schema.session[schema.sessionAliases[name]];
    if (!def && name.startsWith('merge_tree_')) def = schema.mergeTree[name.slice('merge_tree_'.length)];
    if (!def && !customPrefixes.some((p) => name.startsWith(p))) {
      const sug = suggest(name, Object.keys(schema.session));
      add(
        'error',
        'constraint-unknown',
        s,
        `Constraint on unknown setting <${name}>${sug ? `; did you mean <${sug.name}>?` : ''}.`,
        [ref.constraints('defining-constraints')],
      );
      continue;
    }
    let writ = 0;
    for (const c of s.children) {
      if (!kinds.includes(c.name)) {
        add(
          'error',
          'constraint-kind',
          c,
          `Setting ${c.name} value for ${name} isn't supported; use one of ${kinds.join(', ')}.`,
          [ref.constraints('types-of-constraints'), ref.source(SRC.usersParser, 'UsersConfigParser.cpp')],
        );
        continue;
      }
      if (['readonly', 'const', 'changeable_in_readonly'].includes(c.name)) writ++;
      if ((c.name === 'min' || c.name === 'max') && def)
        typeCheck(ctx, c, def.t, {}, [ref.constraints('types-of-constraints')]);
    }
    if (writ > 1)
      add(
        'error',
        'constraint-writability',
        s,
        `Not more than one of const/readonly/changeable_in_readonly is allowed for ${name}.`,
        [ref.constraints('types-of-constraints'), ref.source(SRC.usersParser, 'UsersConfigParser.cpp')],
      );
  }
}
