import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RuleTaskAuthorizationError, RuleTaskQueue, type RuleTaskActor } from "./ruleTaskQueue";
import { enqueueRuleTaskSchema, type RuleTaskAction } from "../shared/ruleTaskQueue";

const actor = (userId = 1): RuleTaskActor => ({ userId, sid: "session", kind: "browser", dev: false, requestId: randomUUID() });
const actions = (count: number): RuleTaskAction[] => Array.from({ length: count }, (_, id) => ({ operation: "delete", input: { id }, conflictStrategy: "error" }));
const request = (count = 1) => ({ requestId: randomUUID(), title: "批量删除", actions: actions(count) });
async function finished(queue: RuleTaskQueue, userId: number, id: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const task = queue.get(userId, id);
    if (task?.finishedAt) return task;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw Error("queue did not finish");
}

test("one global executor rotates users fairly and reports independent outcomes without replaying writes", async () => {
  let active = 0, peak = 0;
  const order: string[] = [];
  const queue = new RuleTaskQueue(async (owner, action) => {
    active++; peak = Math.max(peak, active);
    order.push(`${owner.userId}:${action.input.id}`);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (action.input.id === 1) throw Error("write outcome unknown");
    return action.input.id === 2 ? { skipped: true } : { id: 10 };
  });
  const first = queue.enqueue(actor(), request(3));
  const second = queue.enqueue(actor(2), request(1));
  assert.equal(first.state, "queued");
  assert.equal(second.queuePosition, 2);
  const [a, b] = await Promise.all([finished(queue, 1, first.id), finished(queue, 2, second.id)]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["1:0", "2:0", "1:1", "1:2"]);
  assert.deepEqual([a.completed, a.succeeded, a.failed, a.skipped], [3, 1, 1, 1]);
  assert.equal(a.results?.[1].error, "write outcome unknown");
  assert.equal(b.succeeded, 1);
});

test("request IDs deduplicate accepted work, reject mismatched payloads and isolate ownership", async () => {
  let writes = 0;
  const queue = new RuleTaskQueue(async () => { writes++; return {}; });
  const input = request();
  const first = queue.enqueue(actor(), input);
  assert.equal(queue.enqueue(actor(), input).id, first.id);
  assert.throws(() => queue.enqueue(actor(), { ...input, title: "other" }), /同一提交标识/);
  assert.equal(queue.get(2, first.id), null);
  assert.equal(queue.lookup(2, input.requestId), null);
  assert.equal(queue.cancel(2, first.id), null);
  assert.equal(queue.lookup(1, input.requestId)?.id, first.id);
  input.actions[0].input.id = 999; // caller mutation must not change accepted work
  await finished(queue, 1, first.id);
  assert.equal(writes, 1);
  const snapshot = queue.get(1, first.id)!;
  snapshot.results![0].status = "failed";
  assert.equal(queue.get(1, first.id)!.results![0].status, "succeeded");
  assert.doesNotMatch(JSON.stringify(snapshot), /session|"input"|"actions"/);
});

test("cancellation finishes the current item and leaves the remainder explicitly unexecuted", async () => {
  let release!: () => void;
  let signal!: () => void;
  const entered = new Promise<void>(resolve => { signal = resolve; });
  const queue = new RuleTaskQueue(async () => { signal(); await new Promise<void>(r => { release = r; }); return {}; });
  const id = queue.enqueue(actor(), request(3)).id;
  await entered;
  queue.cancel(1, id);
  release();
  const task = await finished(queue, 1, id);
  assert.equal(task.state, "cancelled");
  assert.deepEqual([task.completed, task.succeeded, task.cancelled], [3, 1, 2]);
});

test("revoked identity stops a job without checking or executing every remaining item", async () => {
  let calls = 0;
  const queue = new RuleTaskQueue(async () => { calls++; throw new RuleTaskAuthorizationError("revoked"); });
  const task = await finished(queue, 1, queue.enqueue(actor(), request(30)).id);
  assert.equal(calls, 1);
  assert.equal(task.failed, 1);
  assert.equal(task.cancelled, 29);
});

test("queue caps reject excess work but never evict an accepted unfinished job", async () => {
  const queue = new RuleTaskQueue(async () => ({}), { maxUserJobs: 1, maxJobs: 2, maxPendingItems: 3 });
  const first = queue.enqueue(actor(), request(2));
  assert.throws(() => queue.enqueue(actor(), request()), /队列已满/);
  assert.throws(() => queue.enqueue(actor(2), request(2)), /队列已满/);
  const second = queue.enqueue(actor(2), request());
  assert.throws(() => queue.enqueue(actor(3), request()), /队列已满/);
  assert.ok(queue.get(1, first.id));
  await Promise.all([finished(queue, 1, first.id), finished(queue, 2, second.id)]);
  const next = queue.enqueue(actor(3), request());
  assert.equal(queue.get(1, first.id), null);
  await finished(queue, 3, next.id);
  const huge = request(); huge.actions[0].input.text = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => queue.enqueue(actor(), huge), /过大/);
});

test("expired results are removed and queued cancellation performs no writes", async () => {
  let calls = 0;
  const queue = new RuleTaskQueue(async () => { calls++; return {}; }, { retentionMs: 5 });
  const task = queue.enqueue(actor(), request(2));
  queue.cancel(1, task.id);
  assert.equal((await finished(queue, 1, task.id)).cancelled, 2);
  assert.equal(calls, 0);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(queue.get(1, task.id), null);
});

test("an active import settles as one save unit and counts logical rows only after commit", async () => {
  let release!: () => void;
  let entered!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const queue = new RuleTaskQueue(async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    return { items: [
      { status: "succeeded", value: { id: 101, sourcePort: 443 } },
      { status: "failed", error: "第 8 行：域名重复" },
      { status: "succeeded", value: { id: 102, sourcePort: 443 } },
    ] };
  });
  const input = { ...request(), actions: [
    { operation: "createBatch", input: { rules: [{}, {}, {}] }, conflictStrategy: "error" },
    ...actions(1),
  ] } as any;
  const id = queue.enqueue(actor(), input).id;
  await saving;
  const pending = queue.get(1, id)!;
  assert.deepEqual([pending.total, pending.completed, pending.succeeded], [4, 0, 0]);
  queue.cancel(1, id);
  release();
  const task = await finished(queue, 1, id);
  assert.deepEqual([task.total, task.completed, task.succeeded, task.failed, task.cancelled], [4, 4, 2, 1, 1]);
  assert.deepEqual(task.results?.map(row => [row.index, row.status]), [[0, "succeeded"], [1, "failed"], [2, "succeeded"], [3, "cancelled"]]);
});

test("unknown save outcomes stop remaining work without classifying them as retryable failures", async () => {
  const { RuleTaskUnknownResultError } = await import("./ruleTaskQueue");
  let writes = 0;
  const queue = new RuleTaskQueue(async () => { writes++; throw new RuleTaskUnknownResultError("核对规则"); });
  const task = queue.enqueue(actor(1), { requestId: "unknown-request", title: "unknown", actions: actions(2) });
  const result = await finished(queue, 1, task.id);
  assert.deepEqual([writes, result.total, result.completed, result.succeeded, result.failed, result.unknown, result.cancelled], [1, 2, 2, 0, 0, 1, 1]);
  assert.deepEqual(result.results?.map(row => row.status), ["unknown", "cancelled"]);
});

test("schema-accepted hostile names and IDs settle rejected items and let other work finish", async () => {
  const hostile = { toString: null, valueOf: null };
  const queue = new RuleTaskQueue(async (_, action) => {
    if (action.operation === "delete" && typeof action.input.id === "number") return { id: action.input.id };
    throw Error("CRUD rejected invalid input");
  });
  const input = enqueueRuleTaskSchema.parse({ requestId: randomUUID(), title: "恶意标签回归", actions: [
    { operation: "create", input: { name: hostile } },
    { operation: "delete", input: { id: hostile } },
    { operation: "createBatch", input: { rules: [{ name: hostile }, { id: hostile }, null, 7, { name: "导入规则", sourceLineNumber: 8 }] } },
    { operation: "delete", input: { id: 99 } },
  ] });
  const first = queue.enqueue(actor(), input);
  const other = queue.enqueue(actor(2), enqueueRuleTaskSchema.parse(request()));
  const [task, next] = await Promise.all([finished(queue, 1, first.id), finished(queue, 2, other.id)]);
  assert.equal(task.state, "completed");
  assert.deepEqual([task.total, task.completed, task.succeeded, task.failed, task.cancelled, task.unknown], [8, 8, 1, 7, 0, 0]);
  assert.deepEqual(task.results?.map(row => [row.index, row.status, row.label]), [
    [0, "failed", undefined], [1, "failed", undefined], [2, "failed", undefined], [3, "failed", undefined],
    [4, "failed", undefined], [5, "failed", undefined], [6, "failed", "导入规则"], [7, "succeeded", "#99"],
  ]);
  assert.ok(task.results?.slice(0, 7).every(row => row.error === "CRUD rejected invalid input"));
  assert.deepEqual([next.total, next.completed, next.succeeded, next.results?.length], [1, 1, 1, 1]);
});

for (const running of [false, true]) test(`hostile labels cannot interrupt ${running ? "running" : "queued"} cancellation or other jobs`, async () => {
  const hostile = { toString: null, valueOf: null };
  let release!: () => void;
  let signal!: () => void;
  const entered = new Promise<void>(resolve => { signal = resolve; });
  const executed: number[] = [];
  const queue = new RuleTaskQueue(async owner => {
    executed.push(owner.userId);
    if (owner.userId === 1) {
      signal();
      await new Promise<void>(resolve => { release = resolve; });
    }
    return {};
  });
  const first = queue.enqueue(actor(), enqueueRuleTaskSchema.parse({ requestId: randomUUID(), title: "取消恶意标签", actions: [
    { operation: "create", input: { name: "当前规则" } },
    { operation: "create", input: { name: hostile } },
    { operation: "delete", input: { id: hostile } },
    { operation: "createBatch", input: { rules: [{ name: hostile }, { id: hostile }, { name: "导入规则", sourceLineNumber: 8 }] } },
    { operation: "delete", input: { id: 99 } },
  ] }));
  const other = queue.enqueue(actor(2), enqueueRuleTaskSchema.parse(request()));
  if (running) await entered;
  queue.cancel(1, first.id);
  if (running) release();
  const [task, next] = await Promise.all([finished(queue, 1, first.id), finished(queue, 2, other.id)]);
  assert.equal(task.state, "cancelled");
  assert.deepEqual([task.total, task.completed, task.succeeded, task.failed, task.cancelled, task.unknown], [7, 7, running ? 1 : 0, 0, running ? 6 : 7, 0]);
  assert.deepEqual(task.results?.map(row => [row.index, row.status, row.label]), [
    [0, running ? "succeeded" : "cancelled", "当前规则"],
    [1, "cancelled", undefined], [2, "cancelled", undefined], [3, "cancelled", undefined], [4, "cancelled", undefined],
    [5, "cancelled", "导入规则"], [6, "cancelled", "#99"],
  ]);
  assert.deepEqual(executed, running ? [1, 2] : [2]);
  assert.deepEqual([next.total, next.completed, next.succeeded, next.results?.length], [1, 1, 1, 1]);
});

test("labels preserve copy targets, import names and line errors, numeric IDs and the 160 character limit", async () => {
  const queue = new RuleTaskQueue(async (_, action) => action.operation === "createBatch"
    ? { items: [{ status: "failed", error: "第 8 行：域名重复" }, { status: "succeeded", value: { id: 102 } }] }
    : {});
  const task = await finished(queue, 1, queue.enqueue(actor(), enqueueRuleTaskSchema.parse({ requestId: randomUUID(), title: "普通标签", actions: [
    { operation: "create", label: "原规则 → 目标资源", input: { name: "复制名称", id: 10 } },
    { operation: "create", input: { name: "普通规则", id: 11 } },
    { operation: "createBatch", input: { rules: [{ name: "导入规则", sourceLineNumber: 8 }, { id: 102, sourceLineNumber: 9 }] } },
    { operation: "delete", input: { id: 12 } },
    { operation: "create", input: { name: "长".repeat(200) } },
    { operation: "delete", input: { name: 123, id: 13 } },
    { operation: "delete", input: { id: "14" } },
  ] })).id);
  assert.deepEqual([task.total, task.completed, task.succeeded, task.failed, task.results?.length], [8, 8, 7, 1, 8]);
  assert.deepEqual(task.results?.map(row => row.label), ["原规则 → 目标资源", "普通规则", "导入规则", "#102", "#12", "长".repeat(160), "#13", undefined]);
  assert.equal(task.results?.[2].error, "第 8 行：域名重复");
  assert.equal(task.results?.[3].value?.id, 102);
});
