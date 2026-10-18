// Entry point shared by the UI and the tests: detect format, parse, validate.

import { parseXml, XmlError } from './xml.js';
import { parseYaml, YamlError } from './tree.js';
import { validate } from './validate.js';
import { setSchema, ref } from './docs.js';

export function detectFormat(text) {
  const t = text.replace(/^﻿/, '').trimStart();
  return t.startsWith('<') ? 'xml' : 'yaml';
}

export function analyze(text, { schema, mode = 'auto', format = 'auto' } = {}) {
  setSchema(schema);
  const fmt = format === 'auto' ? detectFormat(text) : format;
  const src = text.replace(/^﻿/, '');
  if (!src.trim()) return { format: fmt, doc: null, findings: [], mode, recognized: [], empty: true };
  let doc;
  try {
    doc = fmt === 'xml' ? parseXml(src) : parseYaml(src);
  } catch (e) {
    if (e instanceof XmlError || e instanceof YamlError) {
      const refs = fmt === 'xml'
        ? [ref.configFiles(null, 'Configuration files'), { label: 'XML 1.0 well-formedness', url: 'https://www.w3.org/TR/xml/#sec-well-formed' }]
        : [ref.configFiles('example-1', 'YAML examples'), { label: 'YAML 1.2 spec', url: 'https://yaml.org/spec/1.2.2/' }];
      return {
        format: fmt, doc: null, mode, recognized: [], parseError: true,
        findings: [{ sev: 'error', code: 'syntax', msg: `${fmt.toUpperCase()} syntax error: ${e.message}. ClickHouse cannot load this file.`, line: e.line || 1, col: e.col || 1, path: '', refs }],
      };
    }
    throw e;
  }
  const res = validate(doc, { schema, mode, format: fmt });
  return { format: fmt, doc, ...res };
}
