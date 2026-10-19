"""Add per-release availability to schema.json: for every setting, the first and last ClickHouse release whose
settings sources declare it, plus settings that were removed before the generated (master) sources.
Each release is represented by its newest patch tag, so a backported setting counts for the whole release.

Usage: python3 -I releases.py <cache_dir> <schema_json> [tag ...]
<cache_dir> becomes a shallow, sparse git checkout of ClickHouse; per-tag results are cached in <cache_dir>/.scan.
With no tags, the newest -lts/-stable tag of every release since 24.1 is used (git ls-remote).
"""
import sys, os, re, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cppmacro import find_calls

FILES = {
    'server': ['src/Core/ServerSettings.h', 'src/Core/ServerSettings.cpp'],
    'coordination': ['src/Coordination/CoordinationSettings.h', 'src/Coordination/CoordinationSettings.cpp'],
    'mergeTree': ['src/Storages/MergeTree/MergeTreeSettings.h', 'src/Storages/MergeTree/MergeTreeSettings.cpp'],
    'session': ['src/Core/Settings.h', 'src/Core/Settings.cpp', 'src/Core/FormatFactorySettings.h', 'src/Core/FormatFactorySettingsDeclaration.h'],
}
MACROS = ['M', 'DECLARE', 'DECLARE_WITH_ALIAS', 'MAKE_OBSOLETE', 'MAKE_OBSOLETE_MERGE_TREE_SETTING']
IDENT = re.compile(r'[A-Za-z_]\w*')
TYPE = re.compile(r'[A-Za-z_][\w:<> ]*')

def release_tags():
    out = subprocess.run(['git', 'ls-remote', '--tags', 'https://github.com/ClickHouse/ClickHouse.git', 'v2*'],
                         capture_output=True, text=True, check=True).stdout
    best = {}
    for t in re.findall(r'refs/tags/(v\d+\.\d+\.\d+\.\d+-(?:lts|stable))$', out, re.M):
        a = tuple(map(int, re.findall(r'\d+', t)))
        if a[:2] < (24, 1): continue
        if a[:2] not in best or a > best[a[:2]][0]: best[a[:2]] = (a, t)
    return [best[k][1] for k in sorted(best)]

LITERAL = re.compile(r'"([A-Za-z_][\w.]*)"')

def git(cache, *args):
    subprocess.run(['git', '-C', cache, *args], check=True, capture_output=True)

def scan(cache, tag, memo):
    """Check out src/ and programs/ sources at a tag (shallow, sparse) and return declared names per
    category plus every string literal, cached as JSON per tag."""
    path = os.path.join(memo, tag + '.json')
    if tag != 'master' and os.path.exists(path): return json.load(open(path))
    if not os.path.isdir(os.path.join(cache, '.git')):
        os.makedirs(cache, exist_ok=True)
        git(cache, 'init', '-q')
        git(cache, 'remote', 'add', 'origin', 'https://github.com/ClickHouse/ClickHouse.git')
        git(cache, 'sparse-checkout', 'set', '--no-cone', '/src/**/*.cpp', '/src/**/*.h', '/programs/**/*.cpp', '/programs/**/*.h')
    ref = tag if tag == 'master' else 'tags/' + tag
    git(cache, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ('refs/heads/master' if tag == 'master' else f'refs/tags/{tag}') + f':refs/{ref}')
    git(cache, 'checkout', '-q', '--force', f'refs/{ref}')
    lits = set()
    for top in ('src', 'programs'):
        for dp, _, fns in os.walk(os.path.join(cache, top)):
            for fn in fns:
                lits.update(LITERAL.findall(open(os.path.join(dp, fn), encoding='utf-8', errors='replace').read()))
    res = {'literals': sorted(lits), **{cat: sorted(names(cache, files)) for cat, files in FILES.items()}}
    os.makedirs(memo, exist_ok=True)
    json.dump(res, open(path, 'w'))
    return res

def names(cache, files):
    res = set()
    for f in files:
        p = os.path.join(cache, f)
        if not os.path.exists(p): continue
        for macro, a in find_calls(open(p, encoding='utf-8').read(), MACROS):
            if macro.startswith('MAKE_OBSOLETE'):
                if len(a) >= 3 and IDENT.fullmatch(a[2].strip()): res.add(a[2].strip())
            elif len(a) >= 4 and TYPE.fullmatch(a[0].strip()) and IDENT.fullmatch(a[1].strip()):
                res.add(a[1].strip())
    return res

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
    schema = json.load(open(schema_path, encoding='utf-8'))
    versions = [version(t) for t in tags]
    groups = {'server': [schema['server'], schema['serverWithPath']], 'coordination': [schema['coordination']],
              'mergeTree': [schema['mergeTree']], 'session': [schema['session']]}
    # Session and MergeTree settings must be declared to be accepted. Server and Keeper keys can also be read
    # straight from the config, so for them any string literal naming the key counts as support.
    loose = {'server', 'coordination'}
    removed = {}
    for cat in FILES:
        seen = [set(x[cat]) for x in scans]
        for v, s in zip(versions, seen):
            if len(s) < 20: raise SystemExit(f'{cat} {v}: only {len(s)} settings parsed')
        current = set().union(*(g.keys() for g in groups[cat]), schema.get(cat + 'Aliases', {}).keys())
        for g in groups[cat]:
            if g is schema['serverWithPath']:
                # Nested sections (openSSL, query_cache, ...) long predate their ServerSettings entries and are
                # partly read by Poco, outside the scanned sources: no reliable first release.
                for d in g.values(): d.pop('since', None)
                continue
            for name, d in g.items():
                keys = {name, d.get('path', name), d.get('path', name).split('.')[-1]}
                idx = [i for i, s in enumerate(seen) if name in s or (cat in loose and keys & lits[i])]
                d.pop('since', None)
                if idx and idx[0] > 0: d['since'] = versions[idx[0]]
                elif not idx: d['since'] = 'next'  # only in the unreleased sources
        gone = {}
        for name in set().union(*seen) - current:
            if name.isupper() or (cat in loose and name in master_lits): continue
            idx = [i for i, s in enumerate(seen) if name in s]
            gone[name] = [versions[idx[0]] if idx[0] > 0 else None, versions[idx[-1]]]
        removed[cat] = dict(sorted(gone.items()))
        print(f'{cat}: {len(current)} current, {len(gone)} removed', file=sys.stderr)
    schema['releases'] = versions
    schema['removed'] = removed
    json.dump(schema, open(schema_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

main()
