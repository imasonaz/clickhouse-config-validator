#!/usr/bin/env bash
# Download the ClickHouse sources and docs the schema generator reads, then regenerate data/schema.json.
# Usage: tools/fetch_sources.sh [git ref, default master]
set -euo pipefail
REF="${1:-master}"
B="https://raw.githubusercontent.com/ClickHouse/ClickHouse/${REF}"
OUT="$(mktemp -d)"
get() { curl -fsSL "$B/$1" -o "$OUT/${2:-$(basename "$1")}"; }
get src/Core/ServerSettings.cpp
get src/Coordination/CoordinationSettings.cpp
get src/Storages/MergeTree/MergeTreeSettings.cpp
get src/Core/Settings.cpp
get src/Core/FormatFactorySettings.h
get src/Core/SettingsEnums.cpp
get src/Common/ZooKeeper/KeeperFeatureFlags.h
get programs/server/config.xml
get programs/server/users.xml
get programs/keeper/keeper_config.xml
get docs/snippets/components/ServerSettingsExplorer/ServerSettingsExplorer.jsx sse.jsx
get docs/snippets/components/SessionSettingsExplorer/SessionSettingsExplorer.jsx sess_sse.jsx
get docs/snippets/components/MergeTreeSettingsExplorer/MergeTreeSettingsExplorer.jsx mt_sse.jsx
get docs/reference/settings/server-settings/_server_settings_outside_source.mdx
get docs/guides/oss/deployment-and-scaling/keeper/index.mdx keeper.mdx
get docs/concepts/features/configuration/server-config/configuration-files.mdx cfgfiles.mdx
DIR="$(cd "$(dirname "$0")" && pwd)"
CH_REF="$REF" python3 -I "$DIR/gen.py" "$OUT" "$DIR/../data/schema.json"
rm -rf "$OUT"
