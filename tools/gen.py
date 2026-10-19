"""Generate schema.json for the ClickHouse config validator from ClickHouse sources.
Usage: python3 -I gen.py <src_dir> <out_json>"""

import datetime
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cppmacro import cstr, find_calls, read_args

src, out = sys.argv[1], sys.argv[2]


def rd(f):
    with open(os.path.join(src, f), encoding='utf-8') as fh:
        return fh.read()


def clean_desc(d, limit=None):
    d = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', d)  # markdown links -> text
    d = re.sub(r'```.*?```', ' ', d, flags=re.S)
    d = re.sub(r'\s+', ' ', d).strip()
    d = re.sub(r'(\s*\*\*Example\*\*|\s*Note)+$', '', d).strip()
    if limit and len(d) > limit:
        d = d[:limit].rsplit(' ', 1)[0] + '…'
    return d


def clean_default(tok):
    tok = tok.strip()
    if tok.startswith('"') or tok.startswith('R"'):
        return cstr(tok)
    return tok


def region(text, start_pat, end_pat=None):
    i = text.index(start_pat)
    j = text.index(end_pat, i) if end_pat else len(text)
    return text[i:j]


def parse_history(recs):
    """History records `{"26.8", prev, new, "reason"}` (newest first) -> [[version, prev, new, reason]]."""
    out = []
    for r in recs:
        r = r.replace('\\\n', ' ').strip()
        if not r.startswith('{'):
            continue
        a, _ = read_args('(' + r[1:-1] + ')', 0)
        if len(a) < 4 or not a[0].strip().startswith('"'):
            continue
        out.append([cstr(a[0]), clean_default(a[1]), clean_default(a[2]), clean_desc(cstr(a[3]), 300)])
    return out


def parse_list(text, limit=None, path_arg=False):
    res = {}
    aliases = {}
    for macro, a in find_calls(
        text, ['DECLARE', 'DECLARE_WITH_ALIAS', 'MAKE_OBSOLETE', 'MAKE_OBSOLETE_MERGE_TREE_SETTING']
    ):
        if macro.startswith('MAKE_OBSOLETE'):
            if len(a) < 4:
                continue
            t, name, dflt = a[1], a[2], a[3]
            res[name] = {'t': t, 'd': clean_default(dflt), 'obsolete': True}
            h = parse_history(a[4:])
            if h:
                res[name]['h'] = h
            continue
        if len(a) < 4 or not re.fullmatch(r'\w+', a[1] or ''):
            continue
        t, name, dflt, desc = a[0], a[1], a[2], a[3]
        e = {'t': t, 'd': clean_default(dflt), 'desc': clean_desc(cstr(desc), limit)}
        if macro == 'DECLARE_WITH_ALIAS' and len(a) >= 6:
            aliases[a[5].strip()] = name
        if path_arg and len(a) >= 6 and a[5].strip().startswith('"'):
            e['path'] = cstr(a[5])
        flags = a[4] if len(a) > 4 else ''
        if 'OBSOLETE' in flags:
            e['obsolete'] = True
        if 'EXPERIMENTAL' in flags:
            e['tier'] = 'experimental'
        elif 'PRIVATE_PREVIEW' in flags:
            e['tier'] = 'private_preview'
        elif 'BETA' in flags:
            e['tier'] = 'beta'
        h = parse_history(a[6:] if macro == 'DECLARE_WITH_ALIAS' else a[5:])
        if h:
            e['h'] = h
        res[name] = e
    return res, aliases


# ---- server settings
ss = rd('ServerSettings.cpp')
server, _ = parse_list(
    region(ss, '#define LIST_OF_SERVER_SETTINGS_WITHOUT_PATH', '#define LIST_OF_SERVER_SETTINGS_WITH_PATH'), limit=700
)
server_wp, _ = parse_list(
    region(ss, '#define LIST_OF_SERVER_SETTINGS_WITH_PATH', '// clang-format on'), path_arg=True, limit=700
)
profile_allow = re.findall(r'"(\w+)"', region(ss, 'settings_from_profile_allowlist', '};'))


# ServerSettings::checkUnknownSettings: top-level sections accepted besides the settings themselves.
def strings_in(block):
    return re.findall(r'"([^"]+)"', re.sub(r'//[^\n]*', '', block))


strict_sections = (
    strings_in(region(ss, 'known_complex_sections = {', '};')) if 'known_complex_sections = {' in ss else []
)
strict_prefixes = strings_in(region(ss, 'known_prefixes = {', '};')) if 'known_prefixes = {' in ss else []

# ---- coordination settings
cs = rd('CoordinationSettings.cpp')
coord, _ = parse_list(region(cs, '#define LIST_OF_COORDINATION_SETTINGS', '\n\n'), limit=700)
m = re.search(r'DEFAULT_FOUR_LETTER_WORD_CMD\s*=(.*?);', cs, re.S)
four_lw = sorted(set(','.join(re.findall(r'"([^"]*)"', m.group(1))).split(',')) - {''})

# ---- merge tree settings
mt_text = rd('MergeTreeSettings.cpp')
mergetree, mt_alias = parse_list(
    region(mt_text, '#define MERGE_TREE_SETTINGS', '#define APPLY_FOR_IMMUTABLE_MERGE_TREE_SETTINGS'), limit=220
)

# ---- session settings (for profiles)
st = rd('Settings.cpp')
session, s_alias = parse_list(region(st, '#define COMMON_SETTINGS(DECLARE, DECLARE_WITH_ALIAS) \\'), limit=220)
# The obsolete list is parsed on its own: a stray macro-like token earlier in the file can desync one long scan.
obs_s, _ = parse_list(st[st.index('#define OBSOLETE_SETTINGS(M, ALIAS)') :], limit=220)
for k, v in obs_s.items():
    if v.get('obsolete'):
        session[k] = {**session.get(k, {}), **v}
fmt, f_alias = parse_list(rd('FormatFactorySettings.h'), limit=220)
session.update({k: v for k, v in fmt.items() if k not in session})
s_alias.update(f_alias)

# ---- enums
enums = {}
for macro, a in find_calls(rd('SettingsEnums.cpp'), ['IMPLEMENT_SETTING_ENUM', 'IMPLEMENT_SETTING_MULTI_ENUM']):
    if len(a) < 3:
        continue
    vals = re.findall(r'\{\s*"([^"]*)"\s*,', a[2])
    if vals:
        enums[a[0].strip()] = {'values': vals, 'multi': macro.endswith('MULTI_ENUM')}
enums['LogsLevel'] = {
    'values': ['none', 'fatal', 'error', 'warning', 'information', 'debug', 'trace', 'test'],
    'multi': False,
}

# ---- keeper feature flags
kff = rd('KeeperFeatureFlags.h')
flags = [
    f.lower()
    for f in re.findall(r'^\s+([A-Z_]+)(?:\s*=\s*\d+)?,', region(kff, 'enum class KeeperFeatureFlag', '};'), re.M)
]


# ---- doc paths from the docs' settings explorer components
def explorer_paths(fname):
    txt = rd(fname)
    i = txt.index('useState(() => (') + len('useState(() => (')
    depth = 0
    for j in range(i, len(txt)):
        c = txt[j]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                break
    paths = {}

    def walk(gs):
        for g in gs:
            for st_ in g.get('settings', []):
                paths[st_['name']] = st_['path']
            walk(g.get('children', []))

    walk(json.loads(txt[i : j + 1]))
    return paths


doc_paths = explorer_paths('sse.jsx')
session_doc_paths = explorer_paths('sess_sse.jsx')
mt_doc_paths = explorer_paths('mt_sse.jsx')

# ---- reference structure (paths seen in reference configs and doc examples)
ref_paths = {'server': set(), 'keeper': set()}


def add_tree(el, prefix, bucket):
    for ch in el:
        if not isinstance(ch.tag, str):
            continue
        p = prefix + [ch.tag]
        ref_paths[bucket].add('.'.join(p))
        add_tree(ch, p, bucket)


def load_xml_text(txt, bucket):
    txt = re.sub(r'<\?xml[^>]*\?>', '', txt)
    try:
        root = ET.fromstring(txt)
    except ET.ParseError:
        try:
            root = ET.fromstring('<clickhouse>' + txt + '</clickhouse>')
        except ET.ParseError:
            return
    if root.tag not in ('clickhouse', 'yandex'):
        w = ET.Element('clickhouse')
        w.append(root)
        root = w
    add_tree(root, [], bucket)


load_xml_text(rd('config.xml'), 'server')
load_xml_text(rd('users.xml'), 'server')
load_xml_text(rd('keeper_config.xml'), 'keeper')
for f, bucket in (
    ('_server_settings_outside_source.mdx', 'server'),
    ('keeper.mdx', 'keeper'),
    ('cfgfiles.mdx', 'server'),
):
    for blk in re.findall(r'```xml[^\n]*\n(.*?)```', rd(f), re.S):
        load_xml_text(blk, bucket)

schema = {
    'generated': datetime.date.today().isoformat(),
    'source': 'ClickHouse/ClickHouse@' + os.environ.get('CH_REF', 'master'),
    'server': server,
    'serverWithPath': server_wp,
    'serverProfileAllowlist': profile_allow,
    'coordination': coord,
    'fourLetterWords': four_lw,
    'serverStrict': {'sections': strict_sections, 'prefixes': strict_prefixes},
    'keeperFeatureFlags': flags,
    'mergeTree': mergetree,
    'mergeTreeAliases': mt_alias,
    'session': session,
    'sessionAliases': s_alias,
    'enums': enums,
    'docPaths': doc_paths,
    'sessionDocPaths': session_doc_paths,
    'mergeTreeDocPaths': mt_doc_paths,
    'refPaths': {k: sorted(v) for k, v in ref_paths.items()},
}
with open(out, 'w') as fh:
    json.dump(schema, fh, separators=(',', ':'), ensure_ascii=False)
print({k: len(v) if hasattr(v, '__len__') else v for k, v in schema.items()})
