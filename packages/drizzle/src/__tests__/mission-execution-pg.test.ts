import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPgStores, migratePgSchema } from "../index.js";
import { executionPlan } from "./mission-execution-fixture.js";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL Mission admission across independent connections", () => {
  const namespace = `mission_admission_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
  const clientA = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
  const clientB = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
  const dbA = drizzle(clientA), dbB = drizzle(clientB);
  const first = createPgStores(dbA), second = createPgStores(dbB);
  const a = first.missionExecutionStore;
  const b = second.missionExecutionStore;
  beforeAll(async () => {
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
    await migratePgSchema(dbA);
  }, 30_000);
  beforeEach(async () => { await clientA`DELETE FROM tasks`; await clientA`DELETE FROM missions`; });
  afterAll(async () => {
    await Promise.all([clientA.end(), clientB.end()]);
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end();
  });
  const mission = () => first.missionStore.createMission({ name: "Receipt fixture", data: '{"tasks":[]}', status: "recurring", user: "customer-a" });

  it("deduplicates simultaneous retries and returns one stable receipt", async () => {
    const original = await mission();
    const results = await Promise.all([a, b].map(store => store.commitMissionExecution(executionPlan(original))));
    expect(results.map(result => result.created).sort()).toEqual([false, true]);
    expect(results[0].receipt).toEqual(results[1].receipt);
    expect(await second.taskStore.listTasks()).toHaveLength(2);
    expect(await second.missionStore.getMission(original.id)).toMatchObject({ status: "active", executionCount: 1 });
    await migratePgSchema(dbB);
    expect(await b.getMissionExecution(original.id, "occurrence-a")).toEqual(results[0].receipt);
  });

  it("rejects a competing occurrence without partial tasks or a second counter increment", async () => {
    const original = await mission();
    const results = await Promise.allSettled([a, b].map((store, i) => store.commitMissionExecution(executionPlan(original, `occurrence-${i}`))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "mission_execution_conflict" } });
    expect(await first.taskStore.listTasks()).toHaveLength(2);
    expect(await first.missionStore.getMission(original.id)).toMatchObject({ executionCount: 1 });
  });

  it("serializes conflicting task titles across different Missions", async () => {
    const original = await mission();
    const other = await second.missionStore.createMission({ ...original, name: "Other Mission" });
    const results = await Promise.allSettled([a.commitMissionExecution(executionPlan(original)), b.commitMissionExecution(executionPlan(other))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "mission_execution_conflict" } });
    expect(await first.taskStore.listTasks()).toHaveLength(2);
  });

  it("rolls back tasks and Mission state when receipt persistence fails", async () => {
    const original = await mission(), input = executionPlan(original);
    await clientA`CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt failure'; END $$`;
    await clientA`CREATE TRIGGER reject_receipt BEFORE INSERT ON mission_executions FOR EACH ROW EXECUTE FUNCTION reject_receipt()`;
    try {
      await expect(a.commitMissionExecution(input)).rejects.toThrow();
      expect(await second.taskStore.listTasks()).toEqual([]);
      expect(await second.missionStore.getMission(original.id)).toMatchObject({ status: "recurring", executionCount: 0 });
      expect(await b.getMissionExecution(original.id, "occurrence-a")).toBeUndefined();
    } finally {
      await clientA`DROP TRIGGER reject_receipt ON mission_executions`;
      await clientA`DROP FUNCTION reject_receipt()`;
    }
    expect((await b.commitMissionExecution(input)).created).toBe(true);
  });

  it("uses the supplied interactive transaction and recovers a lost commit acknowledgement", async () => {
    const original = await mission(), input = executionPlan(original);
    let committed = false;
    const hosted = createPgStores({ transaction() { throw new Error("primary HTTP handle cannot transact"); } }, {
      transaction: async execute => { await dbA.transaction(execute); committed = true; throw new Error("fixture acknowledgement lost"); },
    }).missionExecutionStore;
    await expect(hosted.commitMissionExecution(input)).rejects.toThrow("acknowledgement lost");
    expect(committed).toBe(true);
    const next = await first.missionStore.updateMission(original.id, { user: "customer-b" });
    expect(await b.commitMissionExecution(executionPlan({ ...next, executionCount: 0 }))).toEqual({ receipt: input.receipt, created: false });
    expect(await second.taskStore.listTasks()).toHaveLength(2);
  });

  it("refuses a driver without transactions instead of sending individual writes", async () => {
    const original = await mission();
    const unsupported = createPgStores({}).missionExecutionStore;
    await expect(unsupported.commitMissionExecution(executionPlan(original))).rejects.toMatchObject({ code: "mission_execution_unsupported" });
    expect(await first.taskStore.listTasks()).toEqual([]);
    expect(await first.missionStore.getMission(original.id)).toMatchObject({ executionCount: 0, status: "recurring" });
  });

  it("copies the captured principal and task graph before awaiting a transaction", async () => {
    const original = await mission(), input = executionPlan(original);
    let entered!: () => void, proceed!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { proceed = resolve; });
    const hosted = createPgStores({}, {
      transaction: async execute => { entered(); await release; return dbA.transaction(execute); },
    }).missionExecutionStore;
    const pending = hosted.commitMissionExecution(input);
    await waiting;
    input.expected.user = "changed-after-call";
    input.receipt.user = "changed-after-call";
    input.receipt.tasks[0].user = "changed-after-call";
    input.receipt.tasks[1].dependsOn = [];
    proceed();
    const { receipt } = await pending;
    expect(receipt.user).toBe("customer-a");
    expect(receipt.tasks[0].user).toBe("customer-a");
    expect(receipt.tasks[1].dependsOn).toEqual([receipt.tasks[0].id]);
    expect(await b.getMissionExecution(original.id, "occurrence-a")).toEqual(receipt);
  });

  it("preserves execution controls in the persisted task read by another worker", async () => {
    const original = await first.missionStore.createMission({ name: "Controls", data: '{}', status: "draft", qualityThreshold: 0 });
    const input = executionPlan(original);
    const controls = { executionMode: "subprocess" as const, questionRounds: 0, priority: 0, sideEffects: false,
      sandbox: { isolation: "fresh" as const }, routing: { labels: ["private"] } };
    Object.assign(input.receipt.tasks[0], controls);
    await a.commitMissionExecution(input);
    expect(await second.taskStore.getTask(input.receipt.tasks[0].id)).toMatchObject(controls);
    await second.taskStore.updateTask(input.receipt.tasks[0].id, { executionMode: "in-process", questionRounds: 1 });
    expect(await first.taskStore.getTask(input.receipt.tasks[0].id)).toMatchObject({ executionMode: "in-process", questionRounds: 1 });
    expect(await b.getMissionExecution(original.id, "occurrence-a")).toEqual(input.receipt);
  });

  it("does not recreate deleted work on a delayed replay from another adapter", async () => {
    const original = await mission(), input = executionPlan(original);
    await a.commitMissionExecution(input);
    await first.taskStore.deleteTasks(() => true);
    await first.missionStore.deleteMission(original.id);
    expect(await b.commitMissionExecution(input)).toEqual({ receipt: input.receipt, created: false });
    expect(await second.taskStore.listTasks()).toEqual([]);
    expect(await second.missionStore.getMission(original.id)).toBeUndefined();
  });

  it("rejects an execution identity already used by another Mission", async () => {
    const original = await mission(), input = executionPlan(original);
    await a.commitMissionExecution(input);
    const other = await second.missionStore.createMission({ name: "Other", data: '{}', status: "draft" });
    const duplicate = executionPlan(other);
    duplicate.receipt.executionId = input.receipt.executionId;
    duplicate.receipt.tasks.forEach(task => { task.title = `Other ${task.title}`; });
    await expect(b.commitMissionExecution(duplicate)).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(await first.taskStore.listTasks()).toHaveLength(2);
    expect(await first.missionStore.getMission(other.id)).toMatchObject({ status: "draft" });
  });
});
