# ClickHouse Config Check

A static, client-side page for troubleshooting ClickHouse **server**, **users** and **Keeper** configuration files in XML or YAML.
Paste or drop a file, several files or a whole config folder; it is parsed, type-checked and linted in the browser, and every finding links to the ClickHouse docs and, where the behaviour comes from server code, to the source file.

Nothing is uploaded. There is no backend.

## What it checks

| Area | Examples |
|---|---|
| Syntax | XML well-formedness with line/column; YAML syntax; YAML-to-XML conversion rules of `YAMLParser.cpp` (`@attr`, `#text`, sequences, the top-level `clickhouse:` key, duplicate and merge keys) |
| Preprocessor | unknown/misspelled attributes, more than one of `incl`/`from_env`/`from_zk`, `<include>` rules, `yaml="true"` placement, `incl` without `include_from` |
| Server settings | 472 settings from `ServerSettings.cpp` with exact parsing rules: size suffixes (`10G`, `10Gi`, not `10GB`), `Bool` accepts only `0/1/true/false`, enums, ranges, trailing slash on `path`/`tmp_path`, nesting under scalars, case-sensitive key typos with "did you mean" |
| Misplaced settings | session settings at the top level, MergeTree settings outside `<merge_tree>`, coordination settings outside `<coordination_settings>`, server settings inside profiles |
| `merge_tree` / profiles / constraints | unknown names are startup errors (`UNKNOWN_SETTING`), values type-checked against `MergeTreeSettings.cpp` and `Settings.cpp` |
| Users | one auth method per user, hash lengths, `networks` keys and subnets, profile/quota references, `grants` conflicts, open users |
| Clusters | `remote_servers` structure as enforced by `Cluster.cpp` (shard/replica elements, missing host/port, shard names all-or-none) |
| Keeper | required keys, coordination settings (unknown keys refuse startup), feature flags, four-letter-word list, `raft_configuration` checks mirrored from `KeeperStateManager.cpp` (duplicate ids/endpoints, own `server_id` present, localhost mixing, raft port collisions), election/heartbeat bounds, even voter counts |
| Merging | `config.d`/`users.d` fragments merged into the main file as `ConfigProcessor.cpp` does (name order, `replace`, `remove`, root checks), then `incl` (from the `include_from` file), `from_env` and `from_zk` substitutions using values you supply; the merged result is validated, with every finding pointing at the file and line it came from. Checked against the output of a real ClickHouse 26.9 server, including which of several identical sibling elements a fragment merges into |
| Lifecycle | obsolete settings (with the version and reason), experimental / private preview / beta settings, `allow_feature_tier` rejections; for a chosen target release (24.1 onwards), settings that don't exist yet and settings that were removed (or that still exist there but are gone in later releases); defaults are shown for that version |
| Logging, disks, encryption | `logger.size`/`rotation` and `count` as Poco parses them (`1GB` fails startup), S3/Azure disk endpoints and credential pairs, encrypted disks and `encryption_codecs` key sizes, `current_key_id`, nonce length |
| Addresses | `listen_host`, `interserver_http_host`, `host`, `hostname`: valid IPv4 / IPv6 / host names, no ports |
| Other sections | `zookeeper`, `logger`, system log tables (`engine` vs `partition_by`/`order_by`/`ttl`…), `storage_configuration` disk/policy references, duplicate ports, `listen_host` conflicts |

In the editor, hovering a key shows its type, default and docs, and typing `<` (or a YAML key) offers the keys valid at that spot. The editor colours XML and YAML syntax. Unknown keys suggest where a key of that name is valid; misspellings get a one-click rename, and misplaced keys a one-click move into the right section (missing sections are created, the rest of the file is left as written). The page also shows a table of every recognised setting with its default, type and default history, re-formats files, converts XML ↔ YAML, and downloads the formatted, converted or merged (`*-preprocessed.xml`) config. Findings export as Markdown or JSON, and **Share link** puts the files in the URL fragment (never sent to a server) with passwords, keys and secrets replaced by `REDACTED`.

With several Keeper configs loaded it cross-checks the ensemble: unique `server_id`s, identical `raft_configuration`, matching coordination timeouts, and server `<zookeeper>` entries that point at Raft ports instead of client ports.

Limitations: substitutions without a value you supply are reported and left unresolved; a lone fragment checked without its main file can't resolve references to other files.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node test/run.mjs             # regression tests (Node 18+)
```

## Command line and CI

```sh
node bin/ch-config-check.mjs /etc/clickhouse-server            # config.xml + config.d and users.xml + users.d, merged
node bin/ch-config-check.mjs --env --version 25.8 deploy/clickhouse
node bin/ch-config-check.mjs --format github deploy/clickhouse # annotations in GitHub Actions
```

Formats: `text`, `markdown`, `json`, `github`. Exit code is 1 when a finding reaches `--fail-on` (default `error`). `--env` resolves `from_env` from the process environment; `--subst file` reads `NAME=value` and `/zk/path=value` lines. It needs only Node 18+ and this repository (no npm install).

GitHub Actions step:

```yaml
- run: node path/to/clickhouse-config-check/bin/ch-config-check.mjs --format github deploy/clickhouse
```

## Settings data

`data/schema.json` is generated from ClickHouse sources and docs (`tools/gen.py`). Refresh it with:

```sh
tools/fetch_sources.sh master   # or a release tag, e.g. v25.8.1.1-lts
```

It then runs `tools/releases.py`, which does a shallow, sparse git checkout of the newest patch of every release since 24.1 and records each setting's first release and any settings that were removed (cached in `~/.cache/ccv-releases`; the first run takes a few minutes). Session and MergeTree settings are exact; for server and Keeper keys, which can be read outside the settings classes, any mention of the key in the sources counts.

`.github/workflows/refresh-schema.yml` does this weekly and opens a pull request when the data changes.

`tools/oracle.mjs` compares the merge simulation with a real server: it runs each case in `test/oracle/` through `clickhouse server` and diffs the preprocessed config with ours. It needs a ClickHouse binary, so it isn't part of CI:

```sh
CLICKHOUSE=/path/to/clickhouse node tools/oracle.mjs [case ...]
```

## Deploy

Any static host works; there is no build step. GitHub Pages: Settings → Pages → Deploy from branch, root. Cloudflare Pages (gives `<name>.pages.dev`): connect the repository, framework preset None, empty build command, output directory `/`.

`vendor/yaml.min.mjs` is the [`yaml`](https://eemeli.org/yaml/) 2.8.1 package (ISC licence) bundled as one ES module.

Not affiliated with ClickHouse, Inc.
