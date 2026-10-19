"""Add per-release data to schema.json, from the settings sources of every ClickHouse release:
- `since` on each setting (first release that has it) and `removed` (settings gone before master);
- `dh` on server and coordination settings: default value changes, [[release, default], ...] oldest first
  (session and MergeTree settings carry their own default history in `h`);
- `th` on any setting whose feature tier changed: [[release, tier or null], ...] oldest first;
- `since` / `removed` per enum value (enums.<Type>), Keeper feature flag and four-letter-word command.
Each release is represented by its newest patch tag, so a backported setting counts for the whole release.

Usage: python3 -I releases.py <cache_dir> <schema_json> [tag ...]
<cache_dir> becomes a shallow, sparse git checkout of ClickHouse; per-tag results are cached in <cache_dir>/.scan.
With no tags, the newest -lts/-stable tag of every release since 24.1 is used (git ls-remote).
"""

import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cppmacro import cstr, find_calls

FILES = {
    'server': ['src/Core/ServerSettings.h', 'src/Core/ServerSettings.cpp'],
    'coordination': ['src/Coordination/CoordinationSettings.h', 'src/Coordination/CoordinationSettings.cpp'],
    'mergeTree': ['src/Storages/MergeTree/MergeTreeSettings.h', 'src/Storages/MergeTree/MergeTreeSettings.cpp'],
    'session': [
        'src/Core/Settings.h',
        'src/Core/Settings.cpp',
        'src/Core/FormatFactorySettings.h',
        'src/Core/FormatFactorySettingsDeclaration.h',
    ],
}
MACROS = ['M', 'DECLARE', 'DECLARE_WITH_ALIAS', 'MAKE_OBSOLETE', 'MAKE_OBSOLETE_MERGE_TREE_SETTING']
IDENT = re.compile(r'[A-Za-z_]\w*')
TYPE = re.compile(r'[A-Za-z_][\w:<> ]*')


def release_tags():
    out = subprocess.run(
        ['git', 'ls-remote', '--tags', 'https://github.com/ClickHouse/ClickHouse.git', 'v2*'],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    best = {}
    for t in re.findall(r'refs/tags/(v\d+\.\d+\.\d+\.\d+-(?:lts|stable))$', out, re.M):
        a = tuple(map(int, re.findall(r'\d+', t)))
        if a[:2] < (24, 1):
            continue
        if a[:2] not in best or a > best[a[:2]][0]:
            best[a[:2]] = (a, t)
    return [best[k][1] for k in sorted(best)]


LITERAL = re.compile(r'"([A-Za-z_][\w.]*)"')
SCAN_VERSION = 4


def read(cache, f):
    p = os.path.join(cache, f)
    return open(p, encoding='utf-8', errors='replace').read() if os.path.exists(p) else ''


def git(cache, *args):
    r = subprocess.run(['git', '-C', cache, *args], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f'git {" ".join(args)} failed: {r.stderr.strip()}')


def scan(cache, tag, memo):
    """Check out src/ and programs/ sources at a tag (shallow, sparse) and return declared names per
    category plus every string literal, cached as JSON per tag."""
    path = os.path.join(memo, f'{tag}.v{SCAN_VERSION}.json')
    if tag != 'master' and os.path.exists(path):
        return json.load(open(path))
    if not os.path.isdir(os.path.join(cache, '.git')):
        os.makedirs(cache, exist_ok=True)
        git(cache, 'init', '-q')
        git(cache, 'remote', 'add', 'origin', 'https://github.com/ClickHouse/ClickHouse.git')
        git(
            cache,
            'sparse-checkout',
            'set',
            '--no-cone',
            '/src/**/*.cpp',
            '/src/**/*.h',
            '/programs/**/*.cpp',
            '/programs/**/*.h',
        )
    ref = tag if tag == 'master' else 'tags/' + tag
    # '+': master moves on (and shallow fetches never fast-forward), so overwrite the local ref.
    git(
        cache,
        'fetch',
        '-q',
        '--depth',
        '1',
        '--filter=blob:none',
        'origin',
        ('+refs/heads/master' if tag == 'master' else f'+refs/tags/{tag}') + f':refs/{ref}',
    )
    git(cache, 'checkout', '-q', '--force', f'refs/{ref}')
    lits = set()
    for top in ('src', 'programs'):
        for dp, _, fns in os.walk(os.path.join(cache, top)):
            for fn in fns:
                with open(os.path.join(dp, fn), encoding='utf-8', errors='replace') as fh:
                    lits.update(LITERAL.findall(fh.read()))
    enums = {}
    for _macro, a in find_calls(
        read(cache, 'src/Core/SettingsEnums.cpp'), ['IMPLEMENT_SETTING_ENUM', 'IMPLEMENT_SETTING_MULTI_ENUM']
    ):
        vals = re.findall(r'\{\s*"([^"]*)"\s*,', a[2]) if len(a) >= 3 else []
        if vals:
            enums[a[0].strip()] = vals
    kff = read(cache, 'src/Common/ZooKeeper/KeeperFeatureFlags.h') or read(
        cache, 'src/Coordination/KeeperFeatureFlags.h'
    )  # moved in 24.12
    m = re.search(r'enum class KeeperFeatureFlag[^{]*\{(.*?)\};', kff, re.S)
    flags = [f.lower() for f in re.findall(r'^\s+([A-Z_]+)(?:\s*=\s*\d+)?,?\s*$', m.group(1), re.M)] if m else []
    # Four-letter words: every registered command plus the default allow list.
    fourlw = set(
        re.findall(
            r'String name\(\) override\s*\{\s*return "(\w{4})";', read(cache, 'src/Coordination/FourLetterCommand.h')
        )
    )
    for f in ('src/Coordination/CoordinationSettings.cpp', 'src/Coordination/CoordinationSettings.h'):
        m = re.search(r'DEFAULT_FOUR_LETTER_WORD_CMD\s*=(.*?);', read(cache, f), re.S)
        if m:
            fourlw |= set(','.join(re.findall(r'"([^"]*)"', m.group(1))).split(',')) - {''}
    res = {
        'literals': sorted(lits),
        'decls': {cat: decls(cache, files) for cat, files in FILES.items()},
        'enums': enums,
        'flags': flags,
        'fourlw': sorted(fourlw),
    }
    os.makedirs(memo, exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(res, fh)
    return res


def norm_default(tok):
    """A literal default as a plain value (string, number or bool); None for anything computed or symbolic
    (named constants, function calls), which can't be compared across releases."""
    tok = tok.strip()
    if tok.startswith('"') or tok.startswith('R"'):
        return cstr(tok)
    tok = re.sub(r"(?<=\d)'(?=\d)", '', tok)
    tok = re.sub(r'(?<=\d)(ULL|UL|LL|U|L|u|ul|ull)\b', '', tok)
    tok = re.sub(r'\s+', '', tok)
    if tok in ('true', 'false'):
        return tok
    if re.fullmatch(r'[-+]?\d+(\.\d*)?([eE][-+]?\d+)?', tok):
        return tok
    if re.fullmatch(r'[\d*+()-]+', tok) and re.search(r'\d[*+-]\d|\)', tok):
        try:
            return str(eval(tok, {'__builtins__': {}}))  # plain integer arithmetic such as 1024*1024
        except Exception:
            return None
    return None


def tier_of(flags):
    return (
        'experimental'
        if 'EXPERIMENTAL' in flags
        else 'private_preview'
        if 'PRIVATE_PREVIEW' in flags
        else 'beta'
        if 'BETA' in flags
        else None
    )


def decls(cache, files):
    """{name: [default, tier]} for every setting declared in the given files."""
    res = {}
    for f in files:
        for macro, a in find_calls(read(cache, f), MACROS):
            if macro.startswith('MAKE_OBSOLETE'):
                if len(a) >= 4 and IDENT.fullmatch(a[2].strip()):
                    res[a[2].strip()] = [norm_default(a[3]), None]
            elif len(a) >= 4 and TYPE.fullmatch(a[0].strip()) and IDENT.fullmatch(a[1].strip()):
                res[a[1].strip()] = [norm_default(a[2]), tier_of(a[4] if len(a) > 4 else '')]
    return res


def changes(series):
    """[(release, value), ...] for each release -> the entries where the value changes (first entry kept)."""
    out = []
    for v, x in series:
        if not out or out[-1][1] != x:
            out.append([v, x])
    return out


def lifetimes(versions, sets, current):
    """since (not in the oldest release) and removed ([first, last]) for a family of names."""
    since, removed = {}, {}
    for name in set().union(*sets) | set(current):
        idx = [i for i, s in enumerate(sets) if name in s]
        if name in current:
            if not idx:
                since[name] = 'next'
            elif idx[0] > 0:
                since[name] = versions[idx[0]]
        else:
            removed[name] = [versions[idx[0]] if idx[0] > 0 else None, versions[idx[-1]]]
    return dict(sorted(since.items())), dict(sorted(removed.items()))


def version(tag):
    return '.'.join(re.findall(r'\d+', tag)[:2])


def main():
    cache, schema_path, *tags = sys.argv[1:]
    tags = tags or release_tags()
    memo = os.path.join(cache, '.scan')
    scans = [scan(cache, t, memo) for t in tags]
    master = scan(cache, 'master', memo)
    master_lits = set(master['literals'])
    lits = [set(x['literals']) for x in scans]
    with open(schema_path, encoding='utf-8') as fh:
        schema = json.load(fh)
    versions = [version(t) for t in tags]
    groups = {
        'server': [schema['server'], schema['serverWithPath']],
        'coordination': [schema['coordination']],
        'mergeTree': [schema['mergeTree']],
        'session': [schema['session']],
    }
    # Session and MergeTree settings must be declared to be accepted. Server and Keeper keys can also be read
    # straight from the config, so for them any string literal naming the key counts as support.
    loose = {'server', 'coordination'}
    tier_start = {
        cat: next((i for i, x in enumerate(scans) if any(t for _, t in x['decls'][cat].values())), len(scans))
        for cat in FILES
    }
    removed = {}
    for cat in FILES:
        dec = [x['decls'][cat] for x in scans]
        seen = [set(d) for d in dec]
        for v, s in zip(versions, seen, strict=True):
            if len(s) < 20:
                raise SystemExit(f'{cat} {v}: only {len(s)} settings parsed')
        current = set().union(*(g.keys() for g in groups[cat]), schema.get(cat + 'Aliases', {}).keys())
        for g in groups[cat]:
            if g is schema['serverWithPath']:
                # Nested sections (openSSL, query_cache, ...) long predate their ServerSettings entries and are
                # partly read by Poco, outside the scanned sources: no reliable first release.
                for d in g.values():
                    d.pop('since', None)
                continue
            for name, d in g.items():
                keys = {name, d.get('path', name), d.get('path', name).split('.')[-1]}
                idx = [i for i, s in enumerate(seen) if name in s or (cat in loose and keys & lits[i])]
                d.pop('since', None)
                if idx and idx[0] > 0:
                    d['since'] = versions[idx[0]]
                elif not idx:
                    d['since'] = 'next'  # only in the unreleased sources
                present = [(versions[i], dec[i][name]) for i in range(len(tags)) if name in dec[i]]
                d.pop('dh', None)
                d.pop('th', None)
                if cat in loose:
                    dh = changes([(v, x[0]) for v, x in present if x[0] is not None])
                    if len(dh) > 1:
                        d['dh'] = dh
                # Tiers only exist since the flags were introduced; before that a missing flag means "unknown".
                th = changes([(v, x[1]) for v, x in present if versions.index(v) >= tier_start[cat]])
                if len(th) > 1 or (th and th[-1][1] != d.get('tier')):
                    d['th'] = th
        gone = {}
        for name in set().union(*seen) - current:
            if name.isupper() or (cat in loose and name in master_lits):
                continue
            idx = [i for i, s in enumerate(seen) if name in s]
            gone[name] = [versions[idx[0]] if idx[0] > 0 else None, versions[idx[-1]]]
        removed[cat] = dict(sorted(gone.items()))
        print(f'{cat}: {len(current)} current, {len(gone)} removed', file=sys.stderr)
    # Enum values, Keeper feature flags and four-letter words.
    for name, e in schema['enums'].items():
        e.pop('since', None)
        e.pop('removed', None)
        sets = [set(x['enums'][name]) for x in scans if name in x['enums']]
        vs = [v for v, x in zip(versions, scans, strict=True) if name in x['enums']]
        if not sets:
            continue
        since, gone = lifetimes(vs, sets, e['values'])
        if since:
            e['since'] = since
        if gone:
            e['removed'] = gone
    fs, fg = lifetimes(versions, [set(x['flags']) for x in scans], schema['keeperFeatureFlags'])
    schema['fourLetterWords'] = sorted(set(schema['fourLetterWords']) | set(master['fourlw']))
    ws, wg = lifetimes(versions, [set(x['fourlw']) for x in scans], schema['fourLetterWords'])
    schema['keeperFeatureFlagsSince'], schema['keeperFeatureFlagsRemoved'] = fs, fg
    schema['fourLetterWordsSince'], schema['fourLetterWordsRemoved'] = ws, wg
    print(
        f'enums: {sum(len(e.get("since", {})) for e in schema["enums"].values())} newer values; flags: {fs}; 4lw: {ws}',
        file=sys.stderr,
    )

    # Releases that reject unknown config elements (checked on the fetched refs; no rescan needed).
    def has(tag, path, needle):
        return (
            subprocess.run(
                ['git', '-C', cache, 'grep', '-q', needle, f'refs/tags/{tag}', '--', path], capture_output=True
            ).returncode
            == 0
        )

    def first(path, needle):
        return next((v for t, v in zip(tags, versions, strict=True) if has(t, path, needle)), 'next')

    schema.setdefault('serverStrict', {})['since'] = first('programs/server/Server.cpp', 'checkUnknownSettings')
    schema['serverStrict']['disksSince'] = first('src/Disks/DiskFactory.cpp', 'checkForUnknownKeys')
    print(
        f'strict top level since {schema["serverStrict"]["since"]}, disks since {schema["serverStrict"]["disksSince"]}',
        file=sys.stderr,
    )
    schema['releases'] = versions
    schema['removed'] = removed
    with open(schema_path, 'w', encoding='utf-8') as fh:
        json.dump(schema, fh, ensure_ascii=False, separators=(',', ':'))


main()
