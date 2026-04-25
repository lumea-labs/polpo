import { sql } from "drizzle-orm";

/**
 * Ensure all PostgreSQL tables exist. Runs CREATE TABLE IF NOT EXISTS for each table.
 * Safe to call on every startup — does nothing if tables already exist.
 *
 * Each statement is executed individually (compatible with both WebSocket and HTTP drivers).
 *
 * @param db A Drizzle PostgreSQL database instance
 */
export async function ensurePgSchema(db: any): Promise<void> {
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
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_status ON tasks(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_group ON tasks("group")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_assign_to ON tasks(assign_to)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_mission_id ON tasks(mission_id)`);
  // OpenAI-compat user column — additive, idempotent
  await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "user" TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_user ON tasks("user")`);

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

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_missions_status ON missions(status)`);
  await db.execute(sql`ALTER TABLE missions ADD COLUMN IF NOT EXISTS "user" TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_missions_user ON missions("user")`);

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

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_status ON runs(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_task_id ON runs(task_id)`);
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS "user" TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_user ON runs("user")`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    agent      TEXT,
    "user"     TEXT,
    metadata   JSONB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "user" TEXT`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata JSONB`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_sessions_user ON sessions("user")`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         TEXT NOT NULL,
    tool_calls TEXT
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_messages_session ON messages(session_id, ts)`);

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

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_entries_session ON log_entries(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_entries_ts ON log_entries(ts)`);

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

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_approvals_status ON approvals(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_approvals_task_id ON approvals(task_id)`);

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

  await db.execute(sql`CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    message_id  TEXT,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size        INTEGER NOT NULL,
    path        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_attachments_session_id ON attachments(session_id)`);

  // Migration: add message_id column if missing (added in v0.2.16)
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'attachments' AND column_name = 'message_id'
      ) THEN
        ALTER TABLE attachments ADD COLUMN message_id TEXT;
      END IF;
    END $$
  `);

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
