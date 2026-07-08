/**
 * F2 backfill — copy historical `loop_runs` rows into the unified `runs` table.
 *
 * The dual-write store (PR2) shadows NEW loop runs into `runs`; this covers the
 * rows that existed before dual-write. Idempotent (`ON CONFLICT (id) DO
 * NOTHING`), so it is safe to run on every deploy. Runs AFTER `ensurePgSchema`
 * (the new columns must exist). Maps loop columns → runs columns, fills the
 * NOT-NULL task columns with the same sentinels the runs-backed store uses, and
 * tags every copied row `engine='graph'`.
 *
 * Read-flip (PR4) must happen AFTER this has run, or historical loop runs would
 * momentarily vanish from `listRuns`.
 */
import { sql } from "drizzle-orm";
import type { Dialect } from "./utils.js";

const COLUMNS =
  "id, task_id, pid, agent_name, adapter_type, session_id, status, started_at, updated_at, activity, config_path, resume_state, loop_name, context, trace, error, approval_request_id, approval, metadata, completed_at, engine";

export async function backfillLoopRunsIntoRuns(db: any, dialect: Dialect): Promise<void> {
  if (dialect === "pg") {
    await db.execute(sql.raw(
      `INSERT INTO runs (${COLUMNS}, "user")
       SELECT id, id, 0, COALESCE(agent_name, ''), 'loop', session_id, status, started_at, updated_at,
              '{}'::jsonb, '', resume, loop_name, context, trace, error, approval_request_id, approval,
              metadata, completed_at, 'graph', "user"
       FROM loop_runs
       ON CONFLICT (id) DO NOTHING`,
    ));
  } else {
    // SQLite: `INSERT OR IGNORE` for idempotency — SQLite can't parse a bare
    // `ON CONFLICT … DO NOTHING` after a SELECT without a WHERE/LIMIT.
    await db.run(sql.raw(
      `INSERT OR IGNORE INTO runs (${COLUMNS}, user)
       SELECT id, id, 0, COALESCE(agent_name, ''), 'loop', session_id, status, started_at, updated_at,
              '{}', '', resume, loop_name, context, trace, error, approval_request_id, approval,
              metadata, completed_at, 'graph', user
       FROM loop_runs`,
    ));
  }
}
