// Example configurations. The first one loads on start and intentionally contains mistakes.

export const SAMPLES = [
  {
    id: 'server-xml-issues',
    label: 'Server XML (with mistakes)',
    name: 'config.d/example.xml',
    text: `<?xml version="1.0"?>
<clickhouse>
    <logger>
        <level>verbose</level>
        <log>/var/log/clickhouse-server/clickhouse-server.log</log>
        <errorlog>/var/log/clickhouse-server/clickhouse-server.err.log</errorlog>
        <size>1000M</size>
        <count>10</count>
    </logger>

    <listen_host>::</listen_host>
    <http_port>8123</http_port>
    <tcp_port>9000</tcp_port>
    <interserver_http_port>9000</interserver_http_port>

    <max_concurrent_querys>200</max_concurrent_querys>
    <mark_cache_size>5GB</mark_cache_size>
    <max_server_memory_usage_to_ram_ratio>0.8</max_server_memory_usage_to_ram_ratio>
    <path>/var/lib/clickhouse</path>

    <!-- Query-level settings do nothing here -->
    <max_memory_usage>10000000000</max_memory_usage>

    <merge_tree>
        <parts_to_throw_inserts>600</parts_to_throw_inserts>
        <max_suspicious_broken_parts>5</max_suspicious_broken_parts>
    </merge_tree>

    <remote_servers>
        <prod>
            <shard>
                <internal_replication>true</internal_replication>
                <replica><host>ch-1</host><port>9000</port></replica>
                <replica><port>9000</port></replica>
            </shard>
        </prod>
    </remote_servers>

    <zookeeper>
        <node><host>keeper-1</host><port>9181</port></node>
        <node><host>keeper-2</host><port>9181</port></node>
        <node><host>keeper-3</host><port>9181</port></node>
        <root>clickhouse</root>
    </zookeeper>

    <macros>
        <shard>01</shard>
        <replica from_env="HOSTNAME"/>
    </macros>

    <query_log>
        <database>system</database>
        <table>query_log</table>
        <engine>ENGINE = MergeTree ORDER BY event_time TTL event_date + INTERVAL 30 DAY</engine>
        <partition_by>toYYYYMM(event_date)</partition_by>
        <flush_interval_milliseconds>7500</flush_interval_milliseconds>
    </query_log>
</clickhouse>
`,
  },
  {
    id: 'keeper-xml',
    label: 'Keeper XML (3 nodes)',
    name: 'keeper_config.xml',
    text: `<clickhouse>
    <logger>
        <level>information</level>
        <log>/var/log/clickhouse-keeper/clickhouse-keeper.log</log>
        <errorlog>/var/log/clickhouse-keeper/clickhouse-keeper.err.log</errorlog>
        <size>1000M</size>
        <count>3</count>
    </logger>
    <listen_host>0.0.0.0</listen_host>
    <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>1</server_id>
        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
        <coordination_settings>
            <operation_timeout_ms>10000</operation_timeout_ms>
            <session_timeout_ms>30000</session_timeout_ms>
            <raft_logs_level>warning</raft_logs_level>
            <async_replication>true</async_replication>
        </coordination_settings>
        <raft_configuration>
            <server><id>1</id><hostname>keeper-1</hostname><port>9234</port></server>
            <server><id>2</id><hostname>keeper-2</hostname><port>9234</port></server>
            <server><id>3</id><hostname>keeper-3</hostname><port>9234</port></server>
        </raft_configuration>
    </keeper_server>
</clickhouse>
`,
  },
  {
    id: 'keeper-yaml-issues',
    label: 'Keeper YAML (with mistakes)',
    name: 'keeper_config.yaml',
    text: `keeper_server:
  tcp_port: 9181
  server_id: 4
  log_storage_path: /var/lib/clickhouse/coordination/log
  snapshot_storage_path: /var/lib/clickhouse/coordination/snapshots
  session_timeout_ms: 30000
  coordination_settings:
    operation_timeout_ms: 10000
    election_timeout_lower_bound_ms: 3000
    election_timeout_upper_bound_ms: 2000
    force_sync: yes
    snapshot_distanse: 100000
  feature_flags:
    multi_read: 1
    filtered_lists: 1
  raft_configuration:
    server:
      - id: 1
        hostname: keeper-1
        port: 9234
      - id: 2
        hostname: keeper-2
        port: 9234
      - id: 2
        hostname: keeper-3
        port: 9234
      - id: 3
        hostname: keeper-4
        port: 9234
`,
  },
  {
    id: 'server-yaml',
    label: 'Server YAML',
    name: 'config.d/network.yaml',
    text: `logger:
  level: information
  log: /var/log/clickhouse-server/clickhouse-server.log
  errorlog: /var/log/clickhouse-server/clickhouse-server.err.log
  size: 1000M
  count: 10
listen_host:
  - "::"
http_port: 8123
tcp_port: 9000
interserver_http_port: 9009
max_connections: 4096
keep_alive_timeout: 10
max_concurrent_queries: 150
mark_cache_size: 5Gi
openSSL:
  client:
    verificationMode: relaxed
zookeeper:
  node:
    - "@index": 1
      host: keeper-1
      port: 9181
    - "@index": 2
      host: keeper-2
      port: 9181
`,
  },
  {
    id: 'users-xml',
    label: 'Users XML (users.d)',
    name: 'users.d/analytics.xml',
    text: `<clickhouse>
    <profiles>
        <analytics>
            <max_memory_usage>20G</max_memory_usage>
            <max_threds>16</max_threds>
            <load_balancing>random</load_balancing>
            <log_queries>yes</log_queries>
            <readonly>1</readonly>
            <use_reader_executor>1</use_reader_executor>
            <enable_sharding_aggregator>1</enable_sharding_aggregator>
        </analytics>
    </profiles>
    <users>
        <alice>
            <password>changeme</password>
            <password_sha256_hex>65e84be33532fb784c48129675f9eff3a682b27168c0ea744b2cf58ee02337c5</password_sha256_hex>
            <networks>
                <ip>10.0.0.0/8</ip>
                <subnet>192.168.0.0/16</subnet>
            </networks>
            <profile>analytics</profile>
            <quota>default</quota>
        </alice>
    </users>
</clickhouse>
`,
  },
  {
    id: 'merge-set',
    label: 'config.d merge (multiple files)',
    files: [
      { path: 'config.xml', text: `<?xml version="1.0"?>
<clickhouse>
    <logger>
        <level>trace</level>
        <log>/var/log/clickhouse-server/clickhouse-server.log</log>
        <size>1000M</size>
        <count>10</count>
    </logger>
    <http_port>8123</http_port>
    <tcp_port>9000</tcp_port>
    <path>/var/lib/clickhouse/</path>
    <max_connections from_env="CH_MAX_CONNECTIONS"/>
    <include_from>/etc/clickhouse-server/metrika.xml</include_from>
    <zookeeper incl="zookeeper-servers"/>
    <remote_servers>
        <default>
            <shard><replica><host>localhost</host><port>9000</port></replica></shard>
        </default>
    </remote_servers>
</clickhouse>
` },
      { path: 'config.d/10-logging.xml', text: `<clickhouse>
    <logger>
        <level>warning</level>
        <console>1</console>
    </logger>
</clickhouse>
` },
      { path: 'config.d/20-cluster.yaml', text: `remote_servers:
  "@replace": true
  prod:
    shard:
      - replica:
          host: ch-1
          port: 9000
      - replica:
          host: ch-2
          port: 9000
http_port:
  "@remove": 1
` },
      { path: 'config.d/30-tuning.xml', text: `<clickhouse>
    <max_concurrent_queries>lots</max_concurrent_queries>
    <max_table_size_to_dorp>0</max_table_size_to_dorp>
    <merge_tree>
        <max_threads>8</max_threads>
    </merge_tree>
</clickhouse>
` },
      { path: 'metrika.xml', text: `<clickhouse>
    <zookeeper-servers>
        <node><host>zk-1</host><port>2181</port></node>
        <node><host>zk-2</host><port>2181</port></node>
        <node><host>zk-3</host><port>2181</port></node>
    </zookeeper-servers>
</clickhouse>
` },
    ],
    substitutions: 'CH_MAX_CONNECTIONS=8192',
  },
  {
    id: 'keeper-ensemble',
    label: 'Keeper ensemble + server (multiple files)',
    files: [
      { path: 'config.xml', text: `<clickhouse>
    <zookeeper>
        <node><host>keeper-1</host><port>9181</port></node>
        <node><host>keeper-2</host><port>9234</port></node>
        <node><host>keeper-3</host><port>9181</port></node>
    </zookeeper>
</clickhouse>
` },
      { path: 'keeper-1.xml', text: `<clickhouse>
    <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>1</server_id>
        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
        <coordination_settings>
            <operation_timeout_ms>10000</operation_timeout_ms>
            <session_timeout_ms>30000</session_timeout_ms>
        </coordination_settings>
        <raft_configuration>
            <server><id>1</id><hostname>keeper-1</hostname><port>9234</port></server>
            <server><id>2</id><hostname>keeper-2</hostname><port>9234</port></server>
            <server><id>3</id><hostname>keeper-3</hostname><port>9234</port></server>
        </raft_configuration>
    </keeper_server>
</clickhouse>
` },
      { path: 'keeper-2.xml', text: `<clickhouse>
    <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>2</server_id>
        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
        <coordination_settings>
            <operation_timeout_ms>10000</operation_timeout_ms>
            <session_timeout_ms>30000</session_timeout_ms>
            <heart_beat_interval_ms>1000</heart_beat_interval_ms>
        </coordination_settings>
        <raft_configuration>
            <server><id>1</id><hostname>keeper-1</hostname><port>9234</port></server>
            <server><id>2</id><hostname>keeper-2</hostname><port>9234</port></server>
            <server><id>3</id><hostname>keeper-3</hostname><port>9234</port></server>
        </raft_configuration>
    </keeper_server>
</clickhouse>
` },
      { path: 'keeper-3.xml', text: `<clickhouse>
    <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>2</server_id>
        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
        <coordination_settings>
            <operation_timeout_ms>10000</operation_timeout_ms>
            <session_timeout_ms>30000</session_timeout_ms>
        </coordination_settings>
        <raft_configuration>
            <server><id>1</id><hostname>keeper-1</hostname><port>9234</port></server>
            <server><id>2</id><hostname>keeper-2</hostname><port>9235</port></server>
            <server><id>3</id><hostname>keeper-3</hostname><port>9234</port></server>
        </raft_configuration>
    </keeper_server>
</clickhouse>
` },
    ],
  },
  {
    id: 'cluster-nodes',
    label: 'Three server nodes (multiple folders)',
    files: ['ch-1', 'ch-2', 'ch-3'].flatMap((n, i) => [
      { path: `${n}/config.xml`, text: `<clickhouse>
    <listen_host>::</listen_host>
    <tcp_port>9000</tcp_port>
    <http_port>8123</http_port>
    <interserver_http_port>9009</interserver_http_port>
    <zookeeper>
        <node><host>keeper-1</host><port>9181</port></node>
        <node><host>keeper-2</host><port>9181</port></node>
        <node><host>keeper-3</host><port>9181</port></node>
        <root>${i === 2 ? '/clickhouse-prod' : '/clickhouse'}</root>
    </zookeeper>${i === 0 ? `
    <storage_configuration>
        <disks><scratch><path>/mnt/scratch/</path></scratch></disks>
        <policies><tmp><volumes><main><disk>scratch</disk></main></volumes></tmp></policies>
    </storage_configuration>
    <tmp_policy>temp</tmp_policy>` : ''}
</clickhouse>
` },
      { path: `${n}/config.d/cluster.xml`, text: `<clickhouse>
    <remote_servers>
        <prod>
            <shard>
                <internal_replication>true</internal_replication>
                <replica><host>ch-1</host><port>9000</port></replica>
                <replica><host>ch-2</host><port>9000</port></replica>
            </shard>
            <shard>
                <internal_replication>true</internal_replication>
                <replica><host>ch-3</host><port>9000</port></replica>
            </shard>
        </prod>
    </remote_servers>
</clickhouse>
` },
      { path: `${n}/config.d/macros.xml`, text: `<clickhouse>
    <macros>
        <cluster>prod</cluster>
        <shard>01</shard>
        <replica>${i === 1 ? 'ch-1' : n}</replica>
    </macros>
</clickhouse>
` },
    ]),
  },
];
