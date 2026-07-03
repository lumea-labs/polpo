/**
 * bench/lib/client.mjs — thin HTTP client for the public Polpo task API.
 *
 * Speaks only the public REST contract. The API prefix is probed at runtime
 * ("/api/v1" on the current OSS server, "/v1" tolerated for other builds) so
 * the same suite runs unchanged against different runtimes/deployments.
 */

const TERMINAL_STATUSES = new Set(["done", "failed"]);
const ACTIVE_PRE_SPAWN = new Set(["pending", "draft", "awaiting_approval"]);

export class PolpoClient {
  /**
   * @param {string} baseUrl
   * @param {{ apiKey?: string, xffRotate?: boolean }} opts
   *   xffRotate — the OSS server rate-limits 200 req/60s keyed on the
   *   x-forwarded-for header. When benchmarking a LOCAL server we rotate a
   *   synthetic XFF bucket every 150 requests so high-frequency polling
   *   doesn't 429. Disabled in --target mode (a real proxy overwrites XFF);
   *   there the poll interval + shared list polling keep us under the limit.
   */
  constructor(baseUrl, { apiKey, xffRotate = false } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.prefix = null;
    this.headers = { "content-type": "application/json" };
    if (apiKey) this.headers.authorization = `Bearer ${apiKey}`;
    this.xffRotate = xffRotate;
    this.requestCount = 0;
  }

  currentHeaders() {
    if (!this.xffRotate) return this.headers;
    const bucket = Math.floor(this.requestCount / 150);
    return { ...this.headers, "x-forwarded-for": `10.99.${Math.floor(bucket / 250)}.${bucket % 250 + 1}` };
  }

  /** Find the live API prefix by probing the health endpoint. */
  async probe({ timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const prefixes = ["/api/v1", "/v1"];
    let lastErr;
    while (Date.now() < deadline) {
      for (const prefix of prefixes) {
        try {
          const res = await fetch(`${this.baseUrl}${prefix}/health`, { headers: this.headers });
          if (res.ok) {
            this.prefix = prefix;
            return prefix;
          }
          lastErr = new Error(`${prefix}/health → HTTP ${res.status}`);
        } catch (err) {
          lastErr = err;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Polpo API not reachable at ${this.baseUrl}: ${lastErr?.message}`);
  }

  async request(method, path, body) {
    this.requestCount++;
    const res = await fetch(`${this.baseUrl}${this.prefix}${path}`, {
      method,
      headers: this.currentHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.ok || json.ok === false) {
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json.data ?? json;
  }

  createTask(opts) {
    return this.request("POST", "/tasks", opts);
  }

  listTasks() {
    return this.request("GET", "/tasks");
  }

  getTask(taskId) {
    return this.request("GET", `/tasks/${taskId}`);
  }

  deleteTask(taskId) {
    return this.request("DELETE", `/tasks/${taskId}`).catch(() => {});
  }

  killTask(taskId) {
    return this.request("POST", `/tasks/${taskId}/kill`).catch(() => {});
  }

  /**
   * Poll a task to a terminal state.
   * Returns { task, wallMs, spawnMs, timeline, timedOut }.
   *   wallMs  — createdAtMs → terminal state observed
   *   spawnMs — createdAtMs → first observed state past "pending"
   */
  async pollTask(taskId, createdAtMs, { timeoutMs = 120_000, intervalMs = 100 } = {}) {
    const timeline = [];
    let lastStatus = null;
    let spawnMs = null;
    const deadline = createdAtMs + timeoutMs;

    for (;;) {
      const task = await this.getTask(taskId);
      const now = Date.now();
      if (task.status !== lastStatus) {
        timeline.push({ status: task.status, tMs: now - createdAtMs });
        lastStatus = task.status;
      }
      if (spawnMs === null && !ACTIVE_PRE_SPAWN.has(task.status)) {
        spawnMs = now - createdAtMs;
      }
      if (TERMINAL_STATUSES.has(task.status)) {
        return { task, wallMs: now - createdAtMs, spawnMs, timeline, timedOut: false };
      }
      if (now > deadline) {
        return { task, wallMs: now - createdAtMs, spawnMs, timeline, timedOut: true };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * Poll MANY tasks with a single shared GET /tasks loop (one request per
   * interval regardless of task count — keeps concurrency scenarios inside
   * the server's rate limit). Same result shape as pollTask, per task.
   */
  async pollMany(entries, { timeoutMs = 300_000, intervalMs = 200 } = {}) {
    const state = new Map(
      entries.map((e) => [
        e.taskId,
        { createdAtMs: e.createdAtMs, timeline: [], lastStatus: null, spawnMs: null, result: null },
      ]),
    );
    const startMs = Math.min(...entries.map((e) => e.createdAtMs));
    const deadline = startMs + timeoutMs;

    while ([...state.values()].some((s) => s.result === null)) {
      const now = Date.now();
      const tasks = await this.listTasks();
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const [taskId, s] of state) {
        if (s.result) continue;
        const task = byId.get(taskId);
        if (!task) continue;
        if (task.status !== s.lastStatus) {
          s.timeline.push({ status: task.status, tMs: now - s.createdAtMs });
          s.lastStatus = task.status;
        }
        if (s.spawnMs === null && !ACTIVE_PRE_SPAWN.has(task.status)) {
          s.spawnMs = now - s.createdAtMs;
        }
        if (TERMINAL_STATUSES.has(task.status)) {
          s.result = { task, wallMs: now - s.createdAtMs, spawnMs: s.spawnMs, timeline: s.timeline, timedOut: false };
        }
      }
      if (Date.now() > deadline) {
        for (const [taskId, s] of state) {
          if (s.result) continue;
          const task = byId.get(taskId) ?? { id: taskId, status: "unknown" };
          s.result = { task, wallMs: Date.now() - s.createdAtMs, spawnMs: s.spawnMs, timeline: s.timeline, timedOut: true };
        }
        break;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return entries.map((e) => state.get(e.taskId).result);
  }
}

export class MockClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health({ timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/bench/health`);
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`mock LLM not reachable at ${this.baseUrl}`);
  }

  async stats(sid) {
    const res = await fetch(`${this.baseUrl}/bench/stats/${sid}`);
    if (!res.ok) return null;
    return res.json();
  }

  async reset() {
    await fetch(`${this.baseUrl}/bench/reset`, { method: "POST" }).catch(() => {});
  }

  async debug() {
    const res = await fetch(`${this.baseUrl}/bench/debug`);
    return res.ok ? res.json() : [];
  }
}
