// Citation helpers. Every finding links to the ClickHouse docs and, where the behaviour comes from
// the server code rather than the docs, to the source file on GitHub.

export const DOCS = 'https://clickhouse.com/docs';
const SERVER_SETTINGS = `${DOCS}/reference/settings/server-settings/settings`;
const SESSION_SETTINGS = `${DOCS}/reference/settings/session-settings`;
const MERGETREE_SETTINGS = `${DOCS}/reference/settings/merge-tree-settings`;
const KEEPER = `${DOCS}/guides/oss/deployment-and-scaling/keeper`;
const CONFIG_FILES = `${DOCS}/concepts/features/configuration/server-config/configuration-files`;
const USERS = `${DOCS}/concepts/features/configuration/settings/settings-users`;
const CONSTRAINTS = `${DOCS}/concepts/features/configuration/settings/constraints-on-settings`;
const GH = 'https://github.com/ClickHouse/ClickHouse/blob/master';

let schema = null;
/** Set the generated schema the citation helpers look documentation anchors up in. */
export function setSchema(s) {
  schema = s;
}

export const ref = {
  server(name) {
    const p = schema && schema.docPaths[name];
    return {
      label: p ? `Server setting: ${name}` : 'Server settings reference',
      url: p ? `${SERVER_SETTINGS}${p}` : SERVER_SETTINGS,
    };
  },
  session(name) {
    const p = schema && schema.sessionDocPaths[name];
    return {
      label: p ? `Session setting: ${name}` : 'Session settings reference',
      url: p ? `${SESSION_SETTINGS}${p}` : SESSION_SETTINGS,
    };
  },
  mergeTree(name) {
    const p = schema && schema.mergeTreeDocPaths[name];
    return {
      label: p ? `MergeTree setting: ${name}` : 'MergeTree settings reference',
      url: p ? `${MERGETREE_SETTINGS}${p}` : MERGETREE_SETTINGS,
    };
  },
  keeper(anchor = 'keeper-configuration-settings', label = 'Keeper configuration settings') {
    return { label, url: `${KEEPER}#${anchor}` };
  },
  keeperCoordination() {
    return this.keeper('internal-coordination-settings', 'Keeper internal coordination settings');
  },
  keeperFlags() {
    return this.keeper('feature-flags', 'Keeper feature flags');
  },
  keeper4lw() {
    return this.keeper('four-letter-word-commands', 'Keeper four letter word commands');
  },
  keeperHttp() {
    return this.keeper('http-control', 'Keeper HTTP control');
  },
  keeperQuorum() {
    return this.keeper('recovering-after-losing-quorum', 'Keeper: recovering after losing quorum');
  },
  configFiles(anchor, label) {
    return { label: label || 'Configuration files', url: anchor ? `${CONFIG_FILES}#${anchor}` : CONFIG_FILES };
  },
  users(anchor, label) {
    return { label: label || 'Users and roles settings', url: anchor ? `${USERS}#${anchor}` : USERS };
  },
  constraints(anchor) {
    return { label: 'Constraints on settings', url: anchor ? `${CONSTRAINTS}#${anchor}` : CONSTRAINTS };
  },
  source(file, label) {
    return { label: `Source: ${label || file.split('/').pop()}`, url: `${GH}/${file}`, source: true };
  },
};

// Frequently cited source files.
export const SRC = {
  serverSettings: 'src/Core/ServerSettings.cpp',
  settingsParse: 'src/Core/SettingsFieldsConversionHelpers.cpp',
  sizeSuffix: 'src/IO/ReadHelpers.h',
  coordination: 'src/Coordination/CoordinationSettings.cpp',
  keeperState: 'src/Coordination/KeeperStateManager.cpp',
  keeperContext: 'src/Coordination/KeeperContext.cpp',
  keeperServer: 'src/Coordination/KeeperServer.cpp',
  featureFlags: 'src/Common/ZooKeeper/KeeperFeatureFlags.h',
  configProcessor: 'src/Common/Config/ConfigProcessor.cpp',
  yamlParser: 'src/Common/Config/YAMLParser.cpp',
  mergeTree: 'src/Storages/MergeTree/MergeTreeSettings.cpp',
  settings: 'src/Core/Settings.cpp',
  usersParser: 'src/Access/UsersConfigParser.cpp',
  authData: 'src/Access/AuthenticationData.cpp',
  cluster: 'src/Interpreters/Cluster.cpp',
  systemLog: 'src/Interpreters/SystemLog.cpp',
  enums: 'src/Core/SettingsEnums.cpp',
  macros: 'src/Common/Macros.cpp',
  server: 'programs/server/Server.cpp',
  context: 'src/Interpreters/Context.cpp',
};
