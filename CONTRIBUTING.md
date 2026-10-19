# Contributing

## Setup and commands

The page and the CLI need nothing but a browser or Node 18+. The dev tools (ESLint, Prettier) come from npm:

```sh
npm install          # dev tools only; the site itself has no dependencies
npm run check        # lint + tests; run before every commit
npm run format       # Prettier + ESLint --fix
npm test             # regression tests only (node test/run.mjs)
ruff check tools && ruff format tools   # Python data generators
python3 -m http.server 8000             # serve the page locally
```

CI (`.github/workflows/ci.yml`) runs the same lint and tests on every push and pull request.

## Code map

```
index.html, assets/app.css   the page
js/app.js                    UI: editor, gutter, tabs, panels, quick fixes, hover cards, upgrade tab
js/engine.js                 entry points: analyze() for one file, analyzeSet() for a file set (merge + cross-file checks)
js/xml.js, js/tree.js        parsers (XML, YAML via vendor/yaml) producing one shared node shape (see makeNode)
js/merge.js                  ConfigProcessor simulation: fragment order, merge, replace/remove, substitutions
js/validate.js               validate(): generic per-node checks, then the section checks below
js/checks/                   section checks, one file per area
  constants.js               fixed key lists (each cites where it comes from)
  helpers.js                 typeCheck, unknownChild, lifecycle (obsolete / tier / version) and friends
  server.js keeper.js users.js cluster.js storage.js logs.js network.js refs.js
js/cluster.js                cross-file checks: Keeper ensemble, users references, server nodes, port overlap
js/upgrade.js                upgrade report: runs everything at two versions and diffs
js/types.js, js/net.js       value parsers (ClickHouse setting rules vs Poco rules), address syntax
js/versions.js               per-release lookups on the schema (since, removed, defaults, tiers)
js/fix.js                    text edits behind quick fixes (rename, move, unwrap)
js/assist.js, highlight.js   autocomplete / hover docs, syntax colouring
js/format.js, report.js      pretty-print and XML <-> YAML; findings as text / Markdown / JSON / GitHub annotations
js/share.js                  share links (deflated into the URL fragment, secrets redacted)
bin/ch-config-check.mjs      CLI and CI front end (also used by action.yml and .pre-commit-hooks.yaml)
tools/gen.py, releases.py    generate data/schema.json from ClickHouse sources and docs (see README)
tools/oracle.mjs             compares the merge simulation with a real clickhouse binary
tools/startup.mjs            starts a real server on a config and reports whether it came up
tools/zip.sh                 packages a release zip (npm run zip)
test/run.mjs, test/fixtures  regression tests
```

## How a check works

Every check receives `ctx`, built in `validate()`:

- `ctx.cfg`: the config root to check (the YAML `clickhouse:` key is unwrapped); `ctx.schema`: `data/schema.json`
- `ctx.mode`: `'server' | 'users' | 'keeper'`; `ctx.version`: target release or `'latest'`
- `ctx.add(sev, code, node, msg, refs, extra)`: report a finding at `node`'s line. `sev` is `error` (ClickHouse
  refuses to start or load the file), `warning` (it starts but the setting is ignored or behaves unexpectedly) or
  `info` (worth knowing). `code` is a stable kebab-case id used by tests, exports and the upgrade diff.
  `extra.fix` attaches a quick fix (`{ kind: 'rename', to }` or `{ kind: 'move', to: [paths] }`).
- `ctx.valueNode(n)`: report at the line of `n`'s text instead of its opening tag
- `ctx.hasSubst(n)`: true when the value comes from `incl` / `from_env` / `from_zk`; skip value checks then
- `ctx.recognized`: rows for the Settings tab

Tree helpers come from `js/tree.js`: `child(node, name)` (first child, what Poco reads), `childrenNamed`,
`textOf` (trimmed text or null), `getPath(root, 'a.b.c')`, `walk(node, fn)`.

## Adding a check

1. Put it in the `js/checks/` file for its area (or `js/cluster.js` if it needs several files) and call it from
   `validate()` (or `analyzeSet()`).
2. Base the rule on ClickHouse's behaviour, not on a guess: cite the docs with `ref.server(name)` and friends, and the
   source with `ref.source(SRC.x, 'File.cpp (function)')`. Messages say what ClickHouse does ("the server fails to
   start with …", "the value is ignored"), quoting its error text where there is one.
3. Where possible, confirm the behaviour on a real binary with `CLICKHOUSE=/path/to/clickhouse node tools/startup.mjs
   bad.xml`, which reports whether the server came up and its first exception. Say "verified with 26.9" in a message
   only when you did.
4. Add a case to `test/run.mjs`: one that triggers the finding and, for anything that could misfire, one that must not.
5. `npm run check`.

## Conventions

- Plain ES modules, no build step and no runtime dependencies: everything in `js/` must run as-is in the browser.
- Formatting is Prettier's (120 columns, single quotes); don't hand-format around it. Long message strings stay on one
  line so they are easy to grep for.
- Comments explain why (which ClickHouse behaviour a rule mirrors, and where it lives in the source), not what the
  next line does.
- `data/schema.json` is generated; never edit it by hand. Change `tools/gen.py` / `tools/releases.py` and regenerate.
- `test/fixtures/` and `test/oracle/` are excluded from formatting on purpose: some contain deliberate mistakes.

## Releases

Bump `version` in `package.json` (and `package-lock.json`), commit, tag `v<version>`, then `npm run zip [dir]`, which
writes `clickhouse-config-check-v<version>.zip` from the committed tree. Minor versions add checks or features; patch
versions fix them.
