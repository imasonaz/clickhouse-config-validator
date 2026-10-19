// <storage_configuration> disks and policies, object-storage credentials, and encryption keys.

import { child, childrenNamed, textOf } from '../tree.js';
import { ref } from '../docs.js';
import { suggest } from '../types.js';
import { DISK_TYPES } from './constants.js';
import { unknownChild } from './helpers.js';

/** <storage_configuration>: disk types and paths, object-storage disks, policies, volumes and move_factor. */
export function checkStorage(ctx) {
  const sc = child(ctx.cfg, 'storage_configuration');
  if (!sc || ctx.hasSubst(sc)) return;
  const dref = ref.server('storage_configuration');
  const disksEl = child(sc, 'disks');
  const diskNames = new Set(['default', ...(disksEl ? disksEl.children.map((d) => d.name) : [])]);
  if (disksEl) {
    for (const d of disksEl.children) {
      const t = child(d, 'type');
      if (t && textOf(t) && !DISK_TYPES.includes(textOf(t))) {
        const s = suggest(textOf(t), DISK_TYPES);
        ctx.add(
          'warning',
          'disk-type',
          ctx.valueNode(t),
          `Unknown disk type '${textOf(t)}'${s ? `; did you mean '${s.name}'?` : ''}.`,
          [dref],
        );
      }
      if (t && textOf(t) === 'object_storage' && !child(d, 'object_storage_type'))
        ctx.add('error', 'disk-ost', d, 'Disk type object_storage requires <object_storage_type>.', [dref]);
      const p = child(d, 'path');
      if (p && textOf(p) && (!t || textOf(t) === 'local') && !textOf(p).endsWith('/'))
        ctx.add('error', 'disk-path', ctx.valueNode(p), `Disk '${d.name}' path must end with '/'.`, [dref]);
      checkObjectDisk(ctx, d, t ? textOf(t) : null, dref);
      for (const ref_ of ['disk']) {
        const inner = child(d, ref_);
        if (inner && textOf(inner) && !diskNames.has(textOf(inner)))
          ctx.add(
            'warning',
            'disk-ref',
            ctx.valueNode(inner),
            `Disk '${d.name}' wraps disk '${textOf(inner)}', which is not defined in this file.`,
            [dref],
          );
      }
    }
  }
  const pol = child(sc, 'policies');
  if (pol) {
    for (const p of pol.children) {
      const vols = child(p, 'volumes');
      if (!vols) {
        ctx.add('error', 'policy-volumes', p, `Storage policy '${p.name}' has no <volumes>.`, [dref]);
        continue;
      }
      for (const v of vols.children) {
        const disks = childrenNamed(v, 'disk');
        if (!disks.length)
          ctx.add('error', 'volume-disks', v, `Volume '${v.name}' in policy '${p.name}' has no <disk>.`, [dref]);
        for (const d of disks)
          if (textOf(d) && !diskNames.has(textOf(d)))
            ctx.add(
              'warning',
              'volume-disk-ref',
              ctx.valueNode(d),
              `Disk '${textOf(d)}' used by policy '${p.name}' is not defined in this file's <disks>.`,
              [dref],
            );
      }
      const mr = child(p, 'move_factor');
      if (mr && textOf(mr)) {
        const f = Number(textOf(mr));
        if (!(f >= 0 && f <= 1))
          ctx.add('error', 'move-factor', ctx.valueNode(mr), 'move_factor must be between 0 and 1.', [dref]);
      }
    }
  }
}

const OBJECT_TYPES = {
  s3: 's3',
  s3_plain: 's3',
  s3_plain_rewritable: 's3',
  azure_blob_storage: 'azure',
  azure: 'azure',
};

function checkObjectDisk(ctx, d, type, dref) {
  const ost = textOf(child(d, 'object_storage_type'));
  const kind = OBJECT_TYPES[type] || (type === 'object_storage' ? OBJECT_TYPES[ost] : null);
  const has = (k) => !!child(d, k);
  const val = (k) => (textOf(child(d, k)) || '').trim();
  if (kind === 's3') {
    if (!has('endpoint'))
      ctx.add(
        'error',
        's3-endpoint',
        d,
        `S3 disk '${d.name}' has no <endpoint> (the bucket URL, e.g. https://bucket.s3.amazonaws.com/root/).`,
        [dref],
      );
    else if (val('endpoint') && !/^(https?|s3):\/\//i.test(val('endpoint')) && !ctx.hasSubst(child(d, 'endpoint')))
      ctx.add(
        'error',
        's3-endpoint-url',
        ctx.valueNode(child(d, 'endpoint')),
        `<endpoint> '${val('endpoint')}' is not an http(s) or s3:// URL.`,
        [dref],
      );
    const a = has('access_key_id'),
      b = has('secret_access_key');
    if (a !== b)
      ctx.add(
        'error',
        's3-creds',
        child(d, a ? 'access_key_id' : 'secret_access_key'),
        `S3 disk '${d.name}' sets ${a ? 'access_key_id' : 'secret_access_key'} without ${a ? 'secret_access_key' : 'access_key_id'}; both are needed for static credentials.`,
        [dref],
      );
    if (a && b && val('use_environment_credentials') && /^(1|true)$/i.test(val('use_environment_credentials')))
      ctx.add(
        'info',
        's3-creds-both',
        child(d, 'use_environment_credentials'),
        'Both static keys and use_environment_credentials are set; the static keys take precedence.',
        [dref],
      );
  }
  if (kind === 'azure' && !has('storage_account_url') && !has('connection_string') && !has('endpoint'))
    ctx.add(
      'error',
      'azure-endpoint',
      d,
      `Azure disk '${d.name}' needs <endpoint>, <storage_account_url> or <connection_string>.`,
      [dref],
    );
  if (type === 'encrypted') {
    if (!has('disk'))
      ctx.add('error', 'enc-disk', d, `Encrypted disk '${d.name}' needs <disk>, the disk it wraps.`, [
        dref,
        ref.source('src/Disks/DiskEncrypted.cpp', 'DiskEncrypted.cpp'),
      ]);
    const alg = (val('algorithm') || 'aes_128_ctr').toLowerCase();
    const sizes = { aes_128_ctr: 16, aes_192_ctr: 24, aes_256_ctr: 32 };
    if (has('algorithm') && !sizes[alg])
      ctx.add(
        'error',
        'enc-alg',
        ctx.valueNode(child(d, 'algorithm')),
        `Encryption algorithm '${val('algorithm')}' is not supported; use aes_128_ctr, aes_192_ctr or aes_256_ctr.`,
        [dref],
      );
    if (sizes[alg])
      checkKeys(ctx, d, sizes[alg], alg, [
        dref,
        ref.source('src/IO/FileEncryptionCommon.cpp', 'FileEncryptionCommon.cpp'),
      ]);
    const p = child(d, 'path');
    if (p && textOf(p) && !textOf(p).endsWith('/'))
      ctx.add('error', 'enc-path', ctx.valueNode(p), `Encrypted disk '${d.name}' path must end with '/'.`, [dref]);
  }
}

/** key / key_hex children of an encryption section must decode to exactly `bytes` bytes. */
function checkKeys(ctx, sec, bytes, alg, refs) {
  const keys = sec.children.filter((c) => /^key(_hex)?$/.test(c.name));
  const ids = new Map();
  for (const k of keys) {
    if (ctx.hasSubst(k) || k.attrs.has('encrypted_by')) continue;
    const v = textOf(k) ?? '';
    const hex = k.name === 'key_hex';
    if (hex && (!/^[0-9a-fA-F]*$/.test(v) || v.length % 2)) {
      ctx.add(
        'error',
        'enc-key-hex',
        ctx.valueNode(k),
        `<key_hex> must be an even number of hex digits ("Cannot read key_hex").`,
        refs,
      );
      continue;
    }
    const len = hex ? v.length / 2 : new TextEncoder().encode(v).length;
    if (len !== bytes)
      ctx.add(
        'error',
        'enc-key-size',
        ctx.valueNode(k),
        `${alg} needs a ${bytes}-byte key (${bytes * 2} hex digits in <key_hex>); this key is ${len} bytes.`,
        refs,
      );
    const id = k.attrs.get('id')?.value ?? '0';
    if (ids.has(id))
      ctx.add('error', 'enc-key-id', k, `Two keys use id ${id} ("Multiple keys have the same ID").`, refs);
    ids.set(id, k);
  }
  const cur = child(sec, 'current_key_id');
  if (cur && textOf(cur) && !ids.has(textOf(cur).trim()) && keys.length && !keys.some((k) => ctx.hasSubst(k)))
    ctx.add(
      'error',
      'enc-current-key',
      ctx.valueNode(cur),
      `current_key_id ${textOf(cur).trim()} matches no key ("Not found a key with the current ID").`,
      refs,
    );
  else if (!cur && ids.size > 1)
    ctx.add('error', 'enc-current-key', sec, `<${sec.name}> has several keys but no <current_key_id>.`, refs);
  return keys.length;
}

/** <encryption_codecs>: key sizes, current_key_id and nonce length for AES codecs. */
export function checkEncryptionCodecs(ctx) {
  const ec = child(ctx.cfg, 'encryption_codecs');
  if (!ec || ctx.hasSubst(ec)) return;
  const refs = [
    ref.server('encryption_codecs'),
    ref.source('src/Compression/CompressionCodecEncrypted.cpp', 'CompressionCodecEncrypted.cpp'),
  ];
  for (const sec of ec.children) {
    const bytes = { aes_128_gcm_siv: 16, aes_256_gcm_siv: 32 }[sec.name];
    if (!bytes) {
      unknownChild(ctx, sec, ['aes_128_gcm_siv', 'aes_256_gcm_siv'], refs);
      continue;
    }
    if (!checkKeys(ctx, sec, bytes, sec.name, refs) && !ctx.hasSubst(sec))
      ctx.add(
        'error',
        'enc-no-key',
        sec,
        `<${sec.name}> has no <key> or <key_hex> ("No keys, an encryption needs keys to work").`,
        refs,
      );
    const nonce = child(sec, 'nonce_hex') || child(sec, 'nonce');
    if (nonce && textOf(nonce)) {
      const n = textOf(nonce);
      const len = nonce.name === 'nonce_hex' ? n.length / 2 : new TextEncoder().encode(n).length;
      if (len !== 12)
        ctx.add('error', 'enc-nonce', ctx.valueNode(nonce), `The nonce must be 12 bytes; this one is ${len}.`, refs);
    }
  }
}
