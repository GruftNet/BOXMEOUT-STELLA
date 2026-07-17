# Database Replication System

Comprehensive master-slave replication system for BoxMeOut with automatic failover, read scaling, and high availability.

## Overview

This replication system provides:

- **PostgreSQL Streaming Replication**: Real-time data replication using logical replication slots
- **Automatic Failover**: Sub-30 second RTO with automatic replica promotion
- **Read Load Balancing**: Distribute 80% of reads to replicas with multiple strategies
- **Replication Monitoring**: Hourly data consistency verification
- **Conflict Resolution**: Last-write-wins, primary-wins, or reject strategies
- **Replication State Verification**: Track lag, LSN, and replica health

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Application Layer                           │
│  (ReplicationService, FailoverService, ReadLoadBalancer)    │
└─────────────────────────────────────────────────────────────┘
            ↓ Writes        ↓ Reads (80% target)
┌──────────────────────────────┬──────────────────────────────┐
│      Primary Database        │    Replica Pool              │
│  (PostgreSQL, RW)            │  (Replica-1, Replica-2, ...) │
│                              │  (PostgreSQL, RO)            │
└──────────────────────────────┴──────────────────────────────┘
       ↑ Streaming Replication ↓ Write-Ahead Logs (WAL)
       ├─→ Logical Replication Slots
       ├─→ Heartbeat Monitoring
       ├─→ Lag Tracking
       └─→ Auto-Failover Triggers
```

## Components

### ReplicationService
Manages streaming replication lifecycle and monitoring.

**Features:**
- Replication slot creation and management
- Multi-replica connection pooling
- Replication lag monitoring (target: < 5s)
- Periodic health checks every 5 seconds
- Metrics history (1000 recent entries)

```typescript
const replication = new ReplicationService(primaryPool);
await replication.initializeReplication(replicas);

const metrics = await replication.monitorReplicationLag();
const health = await replication.getReplicationHealth();
```

### FailoverService
Automatic failover management with <30 second RTO.

**Features:**
- Primary failure detection
- Best replica selection (lowest lag)
- Automatic promotion to primary
- Promotion status tracking
- Failover event logging

```typescript
const failover = new FailoverService('primary', primaryPool, replicaPools, states);
const context = await failover.executeFailover();
// context: { failedPrimaryId, selectedReplicaId, rtoMs, dataLossBytes }
```

### ReadLoadBalancer
Intelligent read query routing with multiple strategies.

**Strategies:**
- `round-robin`: Cycle through available replicas
- `least-lag`: Route to replica with lowest replication lag
- `random`: Random replica selection
- `geo-affinity`: Location-aware routing (extensible)

**Load Distribution Target:** 80% of reads from replicas

```typescript
const balancer = new ReadLoadBalancer(
  primaryPool,
  replicaPools,
  replicationStates,
  { type: 'least-lag', maxLagMs: 5000 }
);

const rows = await balancer.executeReadQuery(query, params);
const distribution = balancer.getLoadDistribution();
```

### ConflictResolver
Handles data conflicts between primary and replicas.

**Strategies:**
- `last-write-wins`: Use timestamp to determine winner (default)
- `primary-wins`: Always use primary value
- `reject`: Throw error on conflict

```typescript
const resolver = new ConflictResolver({ strategy: 'last-write-wins' });
const resolved = await resolver.resolveConflict({
  primaryValue: 'new',
  replicaValue: 'old',
  primaryTimestamp: now,
  replicaTimestamp: past,
  rowId: '1',
  tableName: 'markets',
  columnName: 'status'
});
```

### ReplicationMonitor
Continuous monitoring and verification of replication state.

**Features:**
- Hourly data consistency verification
- p95 lag tracking (target: < 1 second)
- Failover alerts
- Replication state verification
- Lag target checking

```typescript
const monitor = new ReplicationMonitor(primaryPool);
monitor.startHourlyVerification();

const health = await monitor.verifyReplicationConsistency();
const lagCheck = await monitor.checkLagTargets(metrics);
await monitor.emitFailoverAlert({ ... });
```

## Acceptance Criteria

| Criterion | Target | Implementation |
|-----------|--------|-----------------|
| Replicas catch-up | < 5 seconds | ReplicationService lag monitoring |
| Failover speed | < 30 seconds RTO | FailoverService auto-promotion |
| Read distribution | 80% from replicas | ReadLoadBalancer with strategies |
| Replication lag | < 1 second p95 | ReplicationMonitor lag tracking |
| Data consistency | Verified hourly | ReplicationMonitor verification |
| Failover alerts | Automatic | ReplicationMonitor alert emission |

## Database Schema

### Tables Created by Migration `1724000000000_add-replication-monitoring.js`

#### `replication_state`
Tracks current health and lag of each replica.

```sql
CREATE TABLE replication_state (
  id SERIAL PRIMARY KEY,
  replica_id TEXT UNIQUE NOT NULL,
  is_healthy BOOLEAN DEFAULT TRUE,
  lag_bytes BIGINT DEFAULT 0,
  lag_seconds INTEGER DEFAULT 0,
  last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
  flush_lsn TEXT DEFAULT '0/0',
  replay_lsn TEXT DEFAULT '0/0',
  slot_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `replication_metrics`
Historical replication metrics for analysis.

```sql
CREATE TABLE replication_metrics (
  id SERIAL PRIMARY KEY,
  replica_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  lag_bytes BIGINT NOT NULL,
  lag_seconds INTEGER NOT NULL,
  network_latency_ms INTEGER DEFAULT 0,
  bytes_received BIGINT DEFAULT 0,
  bytes_replayed BIGINT DEFAULT 0,
  transactions_applied INTEGER DEFAULT 0
);
```

#### `failover_events`
Log of all failover events.

```sql
CREATE TABLE failover_events (
  id SERIAL PRIMARY KEY,
  failed_primary_id TEXT NOT NULL,
  selected_replica_id TEXT NOT NULL,
  failover_time TIMESTAMPTZ DEFAULT NOW(),
  rto_ms INTEGER NOT NULL,
  data_loss_bytes BIGINT,
  status TEXT DEFAULT 'completed'
);
```

#### `replication_verification`
Hourly verification results.

```sql
CREATE TABLE replication_verification (
  id SERIAL PRIMARY KEY,
  replica_id TEXT NOT NULL,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  verified BOOLEAN NOT NULL,
  primary_lsn TEXT NOT NULL,
  replica_lsn TEXT NOT NULL,
  lag_seconds INTEGER NOT NULL,
  data_consistent BOOLEAN NOT NULL,
  failure_reason TEXT
);
```

#### `conflict_resolutions`
Log of resolved conflicts.

```sql
CREATE TABLE conflict_resolutions (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  primary_value JSONB,
  replica_value JSONB,
  resolved_value JSONB NOT NULL,
  resolution_strategy TEXT NOT NULL,
  resolved_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Usage

### Initialization

```typescript
import { 
  initializeDatabase,
  getReplicationService,
  getReadLoadBalancer,
  executeReadQuery,
  executeWriteQuery 
} from './database';

// Initialize with replicas
await initializeDatabase(
  new Map([
    ['replica-1', {
      host: 'replica1.example.com',
      port: 5432,
      database: 'boxmeout',
      user: 'repl_user',
      password: 'repl_pass'
    }],
    ['replica-2', {
      host: 'replica2.example.com',
      port: 5432,
      database: 'boxmeout',
      user: 'repl_user',
      password: 'repl_pass'
    }]
  ]),
  { type: 'least-lag', maxLagMs: 5000 },
  { strategy: 'last-write-wins' }
);
```

### Reading with Load Balancing

```typescript
// Automatically routes to replica if available and healthy
const markets = await executeReadQuery<Market>(
  'SELECT * FROM markets WHERE status = $1',
  ['open']
);
```

### Writing to Primary

```typescript
// Writes always go to primary
const inserted = await executeWriteQuery(
  'INSERT INTO markets (...) VALUES (...) RETURNING *'
);
```

### Monitoring

```typescript
const replication = getReplicationService();
const health = await replication.getReplicationHealth();

console.log({
  status: health.status,
  healthyReplicas: `${health.replicasHealthy}/${health.replicasTotal}`,
  p95LagMs: health.lagPercentile95Ms
});
```

## Configuration

### Environment Variables

```env
# Primary database (required)
DATABASE_URL=postgresql://user:pass@primary:5432/boxmeout

# Optional replication config
REPLICATION_ENABLED=true
REPLICATION_HEALTH_CHECK_MS=5000
REPLICATION_VERIFICATION_INTERVAL_MS=3600000
```

### Replica Configuration

Replicas should be configured with:

1. **Replication user** with appropriate permissions:
   ```sql
   CREATE USER repl_user REPLICATION PASSWORD 'repl_pass';
   GRANT CONNECT ON DATABASE boxmeout TO repl_user;
   ```

2. **WAL streaming enabled** in `postgresql.conf`:
   ```
   wal_level = logical
   max_wal_senders = 10
   max_replication_slots = 10
   ```

3. **Standby mode enabled** on replicas:
   ```
   standby_mode = 'on'
   ```

## Testing

Run integration tests:

```bash
npm run test:integration -- replication.integration.test.ts
```

## Limitations & Future Work

### Out of Scope
- Multi-master replication
- Cross-region replication
- Cascading replicas

### Future Enhancements
- Multi-master setup for bidirectional replication
- Cross-region disaster recovery
- Automatic cascading replicas
- Advanced conflict detection (CRDTs)
- Geo-affinity routing with actual location data
- Distributed transaction support

## Troubleshooting

### High Replication Lag

1. Check replica disk I/O:
   ```sql
   SELECT * FROM pg_stat_replication;
   ```

2. Verify network latency between primary and replicas

3. Increase `wal_keep_size` on primary if lagging replicas fall behind

### Failover Not Triggering

1. Verify failover service is initialized
2. Check that at least one replica is healthy
3. Review logs for specific failure reason

### Read Queries Going to Primary

1. Check `getLoadDistribution()` to see actual routing
2. Verify replicas are marked as healthy
3. Check `maxLagMs` threshold in strategy configuration

## Performance Tuning

### Replication Lag Optimization

1. **Increase WAL writer frequency**:
   ```
   wal_writer_delay = 100ms  # Default 200ms
   ```

2. **Tune maintenance work_mem on replicas**:
   ```
   work_mem = 256MB  # For index creation
   ```

3. **Monitor checkpoint activity**:
   ```sql
   SELECT * FROM pg_stat_bgwriter;
   ```

### Read Query Performance

1. Use `least-lag` strategy for consistency-sensitive reads
2. Monitor replica memory pressure
3. Consider connection pooling on replicas

## References

- [PostgreSQL Streaming Replication](https://www.postgresql.org/docs/current/warm-standby.html)
- [PostgreSQL Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html)
- [pg Node Client](https://node-postgres.com/)
