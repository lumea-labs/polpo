import { sql } from "drizzle-orm";

/**
 * Ensure all PostgreSQL tables exist. Runs CREATE TABLE IF NOT EXISTS for each table.
 * Safe to call on every startup — does nothing if tables already exist.
 *
 * Each statement is executed individually (compatible with both WebSocket and HTTP drivers).
 *
 * @param db A Drizzle PostgreSQL database instance
 */
export async function ensurePgTables(db: any): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'
  )`);

  // Migrate existing TEXT → JSONB (safe no-op if already JSONB)
  await db.execute(sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'metadata' AND column_name = 'value' AND data_type = 'text'
      ) THEN
        ALTER TABLE metadata ALTER COLUMN value TYPE JSONB USING value::jsonb;
      END IF;
    END $$
  `);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS tasks (
    id                    TEXT PRIMARY KEY,
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL,
    assign_to             TEXT NOT NULL,
    "group"               TEXT,
    mission_id            TEXT,
    depends_on            JSONB NOT NULL DEFAULT '[]',
    status                VARCHAR(32) NOT NULL DEFAULT 'pending',
    retries               INTEGER NOT NULL DEFAULT 0,
    max_retries           INTEGER NOT NULL DEFAULT 2,
    max_duration          INTEGER,
    retry_policy          JSONB,
    expectations          JSONB NOT NULL DEFAULT '[]',
    metrics               JSONB NOT NULL DEFAULT '[]',
    result                JSONB,
    phase                 VARCHAR(32),
    fix_attempts          INTEGER NOT NULL DEFAULT 0,
    resolution_attempts   INTEGER NOT NULL DEFAULT 0,
    original_description  TEXT,
    session_id            TEXT,
    notifications         JSONB,
    outcomes              JSONB,
    expected_outcomes     JSONB,
    deadline              TEXT,
    priority              TEXT,
    side_effects          INTEGER,
    revision_count        INTEGER,
    sandbox               JSONB,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  )`);

  // OpenAI-compat user column — additive, idempotent
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "user" TEXT`);
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sandbox JSONB`);
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS routing JSONB`);
  // Explicit per-task project loop — additive, idempotent
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS loop TEXT`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS missions (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    data             TEXT NOT NULL,
    prompt           TEXT,
    status           VARCHAR(32) NOT NULL DEFAULT 'draft',
    schedule         TEXT,
    end_date         TEXT,
    quality_threshold TEXT,
    deadline         TEXT,
    notifications    JSONB,
    execution_count  INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )`);

  await db.execute(sql`ALTER TABLE missions ADD COLUMN IF NOT EXISTS "user" TEXT`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS processes (
    agent_name TEXT NOT NULL,
    pid        INTEGER NOT NULL,
    task_id    TEXT NOT NULL,
    started_at TEXT NOT NULL,
    alive      INTEGER NOT NULL DEFAULT 1,
    activity   JSONB NOT NULL DEFAULT '{}'
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS runs (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    pid          INTEGER NOT NULL DEFAULT 0,
    agent_name   TEXT NOT NULL,
    adapter_type TEXT NOT NULL,
    session_id   TEXT,
    status       VARCHAR(32) NOT NULL DEFAULT 'running',
    started_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    activity     JSONB NOT NULL DEFAULT '{}',
    result       JSONB,
    outcomes     JSONB,
    config       JSONB,
    config_path  TEXT NOT NULL
  )`);

  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS "user" TEXT`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS resume_state JSONB`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS execution_mode TEXT`);
  // F2: unified Run — columns folded from loop_runs (additive; hand-maintained
  // here because cloud/node PG uses ensurePgSchema, not the auto-migrator).
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS loop_name TEXT`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS context JSONB`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS trace JSONB`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS error TEXT`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS approval_request_id TEXT`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS approval JSONB`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS metadata JSONB`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS completed_at TEXT`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS collected_at TEXT`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS engine TEXT DEFAULT 'agent'`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS delivery TEXT`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS run_event_sequences (
    run_id       TEXT PRIMARY KEY,
    last_sequence BIGINT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS run_stream_events (
    run_id        TEXT NOT NULL,
    sequence      BIGINT NOT NULL,
    event_id      TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    type          TEXT NOT NULL,
    data          JSONB NOT NULL,
    created_at    TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS run_execution_leases (
    run_id     TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    token      TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS run_cancellation_requests (
    run_id      TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    reason      TEXT
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS loop_runs (
    id                  TEXT PRIMARY KEY,
    loop_name           TEXT NOT NULL,
    agent_name          TEXT,
    session_id          TEXT,
    "user"              TEXT,
    status              VARCHAR(32) NOT NULL DEFAULT 'running',
    context             JSONB NOT NULL DEFAULT '{}',
    trace               JSONB NOT NULL DEFAULT '[]',
    error               TEXT,
    approval_request_id TEXT,
    approval            JSONB,
    resume              JSONB,
    metadata            JSONB,
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    completed_at        TEXT
  )`);

  await db.execute(sql`ALTER TABLE loop_runs ADD COLUMN IF NOT EXISTS resume JSONB`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    agent      TEXT,
    "user"     TEXT,
    metadata   JSONB,
    version    INTEGER NOT NULL DEFAULT 0,
    scope_key  TEXT,
    scope_version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "user" TEXT`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata JSONB`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope_key TEXT`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope_version TEXT`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         TEXT NOT NULL,
    tool_calls TEXT,
    suggestions TEXT,
    tool_call_id TEXT
  )`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS suggestions TEXT`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_call_id TEXT`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS session_continuations (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    fingerprint     TEXT NOT NULL,
    tool_call_id    TEXT NOT NULL,
    run_id          TEXT NOT NULL,
    session_version INTEGER NOT NULL,
    created_at      TEXT NOT NULL
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_session_continuations_key ON session_continuations(session_id, idempotency_key)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_session_continuations_call ON session_continuations(session_id, tool_call_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS conversation_channels (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL DEFAULT '',
    project_id          TEXT NOT NULL,
    provider            TEXT NOT NULL,
    name                TEXT NOT NULL,
    connection_id       TEXT NOT NULL,
    external_channel_id TEXT NOT NULL,
    status              TEXT NOT NULL,
    settings            JSONB NOT NULL DEFAULT '{}',
    idempotency_key     TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS conversation_channel_routes (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL DEFAULT '',
    project_id          TEXT NOT NULL,
    channel_id          TEXT NOT NULL REFERENCES conversation_channels(id) ON DELETE CASCADE,
    agent_name          TEXT NOT NULL,
    allowed_tools       JSONB,
    external_channel_id TEXT NOT NULL DEFAULT '',
    enabled             INTEGER NOT NULL DEFAULT 1,
    priority            INTEGER NOT NULL DEFAULT 100,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  )`);
  await db.execute(sql`ALTER TABLE conversation_channel_routes ADD COLUMN IF NOT EXISTS allowed_tools JSONB`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS log_sessions (
    id         TEXT PRIMARY KEY,
    started_at TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS log_entries (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
    ts         TEXT NOT NULL,
    event      TEXT NOT NULL,
    data       JSONB
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS model_invocation_logs (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT,
    org_id               TEXT,
    run_id               TEXT,
    session_id           TEXT,
    turn_id              TEXT,
    agent_name           TEXT,
    external_user        TEXT,
    mode                 TEXT NOT NULL,
    operation            TEXT NOT NULL,
    requested_provider   TEXT,
    requested_model      TEXT NOT NULL,
    resolved_provider    TEXT,
    resolved_model       TEXT,
    final_provider       TEXT,
    attempt_index        INTEGER,
    attempt_count        INTEGER,
    generation_id        TEXT,
    credential_type      TEXT,
    status               VARCHAR(32) NOT NULL,
    error_class          TEXT,
    error_message        TEXT,
    input_tokens         INTEGER,
    output_tokens        INTEGER,
    reasoning_tokens     INTEGER,
    cached_tokens        INTEGER,
    audio_input_seconds  DOUBLE PRECISION,
    audio_output_seconds DOUBLE PRECISION,
    image_count          INTEGER,
    video_seconds        DOUBLE PRECISION,
    estimated_cost_usd   DOUBLE PRECISION,
    billable_cost_usd    DOUBLE PRECISION,
    cost_source          TEXT NOT NULL DEFAULT 'unknown',
    billing_owner        TEXT NOT NULL DEFAULT 'external',
    raw_metadata         JSONB,
    created_at           TEXT NOT NULL
  )`);


  await db.execute(sql`CREATE TABLE IF NOT EXISTS approvals (
    id           TEXT PRIMARY KEY,
    gate_id      TEXT NOT NULL,
    gate_name    TEXT NOT NULL,
    task_id      TEXT,
    mission_id   TEXT,
    status       VARCHAR(32) NOT NULL DEFAULT 'pending',
    payload      JSONB,
    requested_at TEXT NOT NULL,
    resolved_at  TEXT,
    resolved_by  TEXT,
    note         TEXT
  )`);


  await db.execute(sql`CREATE TABLE IF NOT EXISTS memory (
    key     TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT ''
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS teams (
    name        TEXT PRIMARY KEY,
    description TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS agents (
    name        TEXT PRIMARY KEY,
    team_name   TEXT NOT NULL,
    config      JSONB NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS vault (
    agent       TEXT NOT NULL,
    service     TEXT NOT NULL,
    type        TEXT NOT NULL,
    label       TEXT,
    credentials TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (agent, service)
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS playbooks (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    mission     JSONB NOT NULL,
    parameters  JSONB,
    version     TEXT,
    author      TEXT,
    tags        JSONB,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);



  await db.execute(sql`CREATE TABLE IF NOT EXISTS skills (
    name          TEXT PRIMARY KEY,
    description   TEXT NOT NULL DEFAULT '',
    source        TEXT,
    installed_at  TEXT NOT NULL,
    allowed_tools JSONB,
    tags          JSONB,
    category      TEXT
  )`);
}

/**
 * Ensure all PostgreSQL indexes exist. Kept separate from table creation so
 * the migrator can add missing COLUMNS first — creating an index on a
 * column that predates the column's introduction would fail on databases
 * provisioned by older versions.
 */
export async function ensurePgIndexes(db: any): Promise<void> {
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_conversation_channels_operation ON conversation_channels(org_id, project_id, idempotency_key)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_conversation_channels_destination ON conversation_channels(org_id, project_id, provider, connection_id, external_channel_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_conversation_channels_scope ON conversation_channels(org_id, project_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_conversation_channel_routes_target ON conversation_channel_routes(org_id, project_id, channel_id, agent_name, external_channel_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_conversation_channel_routes_channel ON conversation_channel_routes(channel_id, priority)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_status ON tasks(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_group ON tasks("group")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_assign_to ON tasks(assign_to)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_mission_id ON tasks(mission_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_user ON tasks("user")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_missions_status ON missions(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_missions_user ON missions("user")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_status ON runs(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_task_id ON runs(task_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_user ON runs("user")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_run_stream_events_sequence ON run_stream_events(run_id, sequence)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_run_stream_events_event_id ON run_stream_events(run_id, event_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_run_stream_events_cursor ON run_stream_events(run_id, sequence)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_run_execution_leases_expiry ON run_execution_leases(expires_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_run_cancellation_requests_time ON run_cancellation_requests(requested_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_loop_runs_status ON loop_runs(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_loop_runs_loop_name ON loop_runs(loop_name)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_loop_runs_agent_name ON loop_runs(agent_name)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_loop_runs_session_id ON loop_runs(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_loop_runs_user ON loop_runs("user")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_sessions_user ON sessions("user")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_messages_session ON messages(session_id, ts)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_entries_session ON log_entries(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_entries_ts ON log_entries(ts)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_model_invocations_project_created ON model_invocation_logs(project_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_model_invocations_org_created ON model_invocation_logs(org_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_model_invocations_run ON model_invocation_logs(run_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_model_invocations_session ON model_invocation_logs(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_model_invocations_agent ON model_invocation_logs(agent_name)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_approvals_status ON approvals(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_approvals_task_id ON approvals(task_id)`);
}

/**
 * Ensure all PostgreSQL tables and indexes exist. Runs CREATE TABLE/INDEX
 * IF NOT EXISTS — does NOT evolve existing tables (see migratePgSchema in
 * migrator.ts for the idempotent column migrator).
 */
export async function ensurePgSchema(db: any): Promise<void> {
  await ensurePgTables(db);
  await ensurePgIndexes(db);
}
