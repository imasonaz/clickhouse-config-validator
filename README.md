# ClickHouse Config Check

A static, client-side page for troubleshooting ClickHouse **server**, **users** and **Keeper** configuration files in XML or YAML.
Paste or drop a file; it is parsed, type-checked and linted in the browser, and every finding links to the ClickHouse docs and, where the behaviour comes from server code, to the source file.

Nothing is uploaded. There is no backend.

## What it checks

| Area | Examples |
|---|---|
| Syntax | XML well-formedness with line/column; YAML syntax; YAML-to-XML conversion rules of `YAMLParser.cpp` (`@attr`, `#text`, sequences, the top-level `clickhouse:` key, duplicate and merge keys) |
| Preprocessor | unknown/misspelled attributes, more than one of `incl`/`from_env`/`from_zk`, `<include>` rules, `yaml="true"` placement, `incl` without `include_from` |
| Server settings | 430 settings from `ServerSettings.cpp` with exact parsing rules: size suffixes (`10G`, `10Gi`, not `10GB`), `Bool` accepts only `0/1/true/false`, enums, ranges, trailing slash on `path`/`tmp_path`, nesting under scalars, case-sensitive key typos with "did you mean" |
| Misplaced settings | session settings at the top level, MergeTree settings outside `<merge_tree>`, coordination settings outside `<coordination_settings>`, server settings inside profiles |
| `merge_tree` / profiles / constraints | unknown names are startup errors (`UNKNOWN_SETTING`), values type-checked against `MergeTreeSettings.cpp` and `Settings.cpp` |
| Users | one auth method per user, hash lengths, `networks` keys and subnets, profile/quota references, `grants` conflicts, open users |
| Clusters | `remote_servers` structure as enforced by `Cluster.cpp` (shard/replica elements, missing host/port, shard names all-or-none) |
| Keeper | required keys, coordination settings (unknown keys refuse startup), feature flags, four-letter-word list, `raft_configuration` checks mirrored from `KeeperStateManager.cpp` (duplicate ids/endpoints, own `server_id` present, localhost mixing, raft port collisions), election/heartbeat bounds, even voter counts |
| Other sections | `zookeeper`, `logger`, system log tables (`engine` vs `partition_by`/`order_by`/`ttl`…), `storage_configuration` disk/policy references, duplicate ports, `listen_host` conflicts |

It also shows a table of every recognised setting with its default and type, re-formats the file, and converts XML ↔ YAML.

Limitations: each file is checked on its own, before `config.d`/`users.d` merging, so cross-file references are reported as warnings. Values from `from_env`, `from_zk` and `incl` are not checked.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node test/run.mjs             # regression tests (Node 18+)
node test/cli.mjs path/to/config.xml   # command-line report
```

## Settings data

`data/schema.json` is generated from ClickHouse sources and docs (`tools/gen.py`). Refresh it with:

```sh
tools/fetch_sources.sh master   # or a release tag, e.g. v25.8.1.1-lts
```

`.github/workflows/refresh-schema.yml` does this weekly and opens a pull request when the data changes.

## Deploy

Enable GitHub Pages for the repository (Settings → Pages → Deploy from branch, root). No build step.

`vendor/yaml.min.mjs` is the [`yaml`](https://eemeli.org/yaml/) 2.8.1 package (ISC licence) bundled as one ES module.

Not affiliated with ClickHouse, Inc.
