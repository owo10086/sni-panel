import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { configureRuleTasks, dismissRuleTask, registerRuleTask, ruleTaskScope, ruleTaskTracker, submitRuleTask, updateRuleTasks, waitForRuleTask } from "./ruleTaskTracker";
import type { RuleTaskSnapshot } from "../../../shared/ruleTaskQueue";
import type { RuleTaskAction } from "../../../shared/ruleTaskQueue";
import { ruleCopyRetries, ruleCopySelectionKey, remainingRuleCopyJobs } from "./ruleBatchFlow";
import { runRuleImport } from "./ruleImport";

const snapshot = (): RuleTaskSnapshot => ({ id: randomUUID(), requestId: randomUUID(), title: "批量导入", state: "queued", total: 3,
  completed: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, queuePosition: 1, createdAt: Date.now() });
const done = (task: RuleTaskSnapshot): RuleTaskSnapshot => terminal(task, ["succeeded", "succeeded", "succeeded"]);

function terminal(task: RuleTaskSnapshot, statuses: NonNullable<RuleTaskSnapshot["results"]>[number]["status"][]): RuleTaskSnapshot {
  return { ...task, state: "completed", total: statuses.length, completed: statuses.length,
    succeeded: statuses.filter(status => status === "succeeded").length,
    failed: statuses.filter(status => status === "failed").length,
    skipped: statuses.filter(status => status === "skipped").length,
    cancelled: statuses.filter(status => status === "cancelled").length,
    unknown: statuses.filter(status => status === "unknown").length,
    finishedAt: Date.now(), results: statuses.map((status, index) => ({ index, status })) };
}

async function withTaskStorage(run: () => Promise<void>) {
  const saved = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } });
  try { await run(); }
  finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
}

test("rejected repeated submissions replace their page observer without retaining old closures", async () => {
  await withTaskStorage(async () => {
    const owner = 910, queued = snapshot();
    const actions: RuleTaskAction[] = [1, 2, 3].map(id => ({ operation: "update", input: { id }, conflictStrategy: "error" }));
    let accept!: (value: { instanceId: string; task: RuleTaskSnapshot }) => void;
    let enqueues = 0;
    const observed: number[] = [];
    const api = {
      enqueue: async () => { enqueues++; return new Promise<{ instanceId: string; task: RuleTaskSnapshot }>(resolve => { accept = resolve; }); },
      lookup: async () => ({ instanceId: "bounded-observer", task: null }),
    };
    const first = assert.rejects(submitRuleTask(api, owner, "original", actions, undefined, () => { observed.push(-1); }), /原账号/);
    configureRuleTasks(911);
    accept({ instanceId: "bounded-observer", task: queued }); await first;
    configureRuleTasks(owner);
    for (let index = 0; index < 1000; index++) {
      await assert.rejects(submitRuleTask(api, owner, "repeat", actions, undefined, () => { observed.push(index); }), /不要重复提交/);
    }
    assert.equal(enqueues, 1);
    updateRuleTasks(owner, "bounded-observer", [queued.id], [terminal(queued, ["failed", "failed", "failed"])]);
    assert.deepEqual(observed, [999], "only the latest page observer receives the reconciled result");
  });
});

test("accepted tasks recovered after switching accounts can retry confirmed total failures for every operation", async () => {
  await withTaskStorage(async () => {
    for (const [index, operation] of (["update", "toggle", "restart", "create", "createBatch"] as const).entries()) {
      const owner = 601 + index;
      const actions: RuleTaskAction[] = operation === "createBatch"
        ? [{ operation, input: { rules: [{ name: "one" }, { name: "two" }, { name: "three" }] }, conflictStrategy: "error" }]
        : [1, 2, 3].map(id => ({ operation, input: { id }, conflictStrategy: "error" }));
      let enqueues = 0;
      let accept!: (value: { instanceId: string; task: RuleTaskSnapshot }) => void;
      const queued = snapshot();
      const api = {
        enqueue: async () => {
          enqueues++;
          if (enqueues === 1) return new Promise<{ instanceId: string; task: RuleTaskSnapshot }>(resolve => { accept = resolve; });
          return { instanceId: "recovered-instance", task: terminal(snapshot(), ["failed", "failed", "failed"]) };
        },
        lookup: async () => ({ instanceId: "recovered-instance", task: null }),
      };
      const first = assert.rejects(submitRuleTask(api, owner, "original", actions), /原账号/);
      configureRuleTasks(699);
      accept({ instanceId: "recovered-instance", task: queued });
      await first;
      configureRuleTasks(owner);
      updateRuleTasks(owner, "recovered-instance", [queued.id], [terminal(queued, ["failed", "failed", "failed"])]);
      assert.equal((await submitRuleTask(api, owner, "explicit retry", actions)).failed, 3);
      assert.equal(enqueues, 2, `${operation}: confirmed failures must permit an explicit retry`);
    }
  });
});

test("late mixed copy outcomes reconcile unknown history after unmount and retry only explicit failures", async () => {
  await withTaskStorage(async () => {
    const owner = 710;
    const ownerScope = ruleTaskScope(owner);
    const jobs = [1, 2, 3, 4].map(ruleId => ({ ruleId, resourceId: 20 }));
    const selectionKey = ruleCopySelectionKey("local", [1, 2, 3, 4], [20]);
    const actions = jobs.map(pair => ({ operation: "create" as const, input: pair, conflictStrategy: "error" as const }));
    const queued = { ...snapshot(), total: 4 };
    let accept!: (value: { instanceId: string; task: RuleTaskSnapshot }) => void;
    const submitted: RuleTaskAction[][] = [];
    const api = {
      enqueue: async (input: { actions: RuleTaskAction[] }) => {
        submitted.push(input.actions);
        if (submitted.length === 1) return new Promise<{ instanceId: string; task: RuleTaskSnapshot }>(resolve => { accept = resolve; });
        return { instanceId: "copy-instance", task: terminal(snapshot(), ["succeeded"]) };
      },
      lookup: async () => ({ instanceId: "copy-instance", task: null }),
    };
    const onSettled = (task: RuleTaskSnapshot) => ruleCopyRetries.reconcile(ownerScope, selectionKey, jobs, task);
    const first = assert.rejects(submitRuleTask(api, owner, "copy", actions, undefined, onSettled), /原账号/);
    configureRuleTasks(711);
    accept({ instanceId: "copy-instance", task: queued });
    await first;
    ruleCopyRetries.remember(ownerScope, { selectionKey, failedPairs: [], unknown: true });
    // No page callback is awaiting the rejected promise now. A late poll still
    // belongs to A, while B's task list and retry history remain untouched.
    updateRuleTasks(owner, "copy-instance", [queued.id], [terminal(queued, ["succeeded", "failed", "cancelled", "skipped"])]);
    assert.equal(ruleTaskTracker.snapshot().length, 0);
    assert.equal(ruleCopyRetries.get(ruleTaskScope(711), selectionKey), null);
    assert.deepEqual(remainingRuleCopyJobs(jobs, selectionKey, ruleCopyRetries.get(ownerScope, selectionKey)), [jobs[1]]);
    configureRuleTasks(owner);
    // Even a consumer without retained UI state receives the old result first.
    assert.deepEqual((await submitRuleTask(api, owner, "reopened", actions)).results?.map(result => result.status), ["succeeded", "failed", "cancelled", "skipped"]);
    assert.equal(submitted.length, 1, "recovering results must not enqueue the original selection again");
    const retryJobs = remainingRuleCopyJobs(jobs, selectionKey, ruleCopyRetries.get(ownerScope, selectionKey));
    await submitRuleTask(api, owner, "retry failed pair", retryJobs.map(input => ({ operation: "create", input, conflictStrategy: "error" })));
    assert.deepEqual(submitted[1].map(action => action.input), [{ ruleId: 2, resourceId: 20 }]);
  });
});

test("remounted import consumers leave unknown state on confirmation and submit only failed source rows", async () => {
  await withTaskStorage(async () => {
    const owner = 720;
    const rules = [1, 3, 5, 7].map(sourceLineNumber => ({ name: `line-${sourceLineNumber}`, sourceLineNumber }));
    const actions: RuleTaskAction[] = [{ operation: "createBatch", conflictStrategy: "error", input: { rules } }];
    const queued = { ...snapshot(), total: 4 };
    let accept!: (value: { instanceId: string; task: RuleTaskSnapshot }) => void;
    const submitted: RuleTaskAction[][] = [];
    const api = {
      enqueue: async (input: { actions: RuleTaskAction[] }) => {
        submitted.push(input.actions);
        if (submitted.length === 1) return new Promise<{ instanceId: string; task: RuleTaskSnapshot }>(resolve => { accept = resolve; });
        return { instanceId: "import-instance", task: terminal(snapshot(), ["succeeded"]) };
      },
      lookup: async () => ({ instanceId: "import-instance", task: null }),
    };
    const first = assert.rejects(submitRuleTask(api, owner, "import", actions), /原账号/);
    configureRuleTasks(721);
    accept({ instanceId: "import-instance", task: queued });
    await first;
    configureRuleTasks(owner);
    // The original component is gone. The replacement subscribes while its
    // first resubmission is still unknown, exactly like the disabled import UI.
    let outcomeUnknown = true;
    await assert.rejects(submitRuleTask(api, owner, "remounted", actions, undefined, () => { outcomeUnknown = false; }), /不要重复提交/);
    updateRuleTasks(owner, "import-instance", [queued.id], [terminal(queued, ["succeeded", "failed", "cancelled", "skipped"])]);
    assert.equal(outcomeUnknown, false, "confirmed results must re-enable the replacement import view");
    const createBatch = async (input: typeof rules) => {
      const task = await submitRuleTask(api, owner, "retry import", [{ operation: "createBatch", conflictStrategy: "error", input: { rules: input } }]);
      return { results: task.results!.map(result => result.status === "succeeded"
        ? { status: "fulfilled" as const, value: result.value }
        : { status: "rejected" as const, retryable: result.status === "failed", reason: result.error || result.status }) };
    };
    const recovered = await runRuleImport(rules, { createBatch });
    assert.equal(submitted.length, 1, "retrieving mixed outcomes cannot replay the original batch");
    const failed = recovered.filter(result => result.status === "rejected" && result.retryable).map(result => result.item);
    assert.deepEqual(failed, [{ name: "line-3", sourceLineNumber: 3 }]);
    await runRuleImport(failed, { createBatch });
    assert.deepEqual(submitted[1][0].input.rules, [{ name: "line-3", sourceLineNumber: 3 }]);
    // Reopening the original file after its failed row succeeded must not
    // use the cached old failure to enqueue that row for a third time.
    const reopened = await runRuleImport(rules, { createBatch });
    await runRuleImport(reopened.filter(result => result.status === "rejected" && result.retryable).map(result => result.item), { createBatch });
    assert.equal(submitted.length, 2, "a successful retry must not be replayed from a stale original outcome");
  });
});

test("recovery checks task instance and complete known results before retrying failed subsets of every operation", async () => {
  await withTaskStorage(async () => {
    for (const [offset, operation] of (["update", "toggle", "restart", "create", "createBatch"] as const).entries()) {
      const owner = 730 + offset;
      const rows = [1, 2, 3, 4].map(id => ({ id }));
      const actions: RuleTaskAction[] = operation === "createBatch"
        ? [{ operation, input: { rules: rows, fixedPortFirst: true }, conflictStrategy: "error" }]
        : rows.map(input => ({ operation, input, conflictStrategy: "error" }));
      const queued = { ...snapshot(), total: 4 };
      let accept!: (value: { instanceId: string; task: RuleTaskSnapshot }) => void;
      const submitted: RuleTaskAction[][] = [];
      const api = {
        enqueue: async (input: { actions: RuleTaskAction[] }) => {
          submitted.push(input.actions);
          if (submitted.length === 1) return new Promise<{ instanceId: string; task: RuleTaskSnapshot }>(resolve => { accept = resolve; });
          return { instanceId: "known-instance", task: terminal(snapshot(), ["succeeded"]) };
        },
        lookup: async () => ({ instanceId: "known-instance", task: null }),
      };
      let settled = 0;
      const first = assert.rejects(submitRuleTask(api, owner, "original", actions, undefined, () => { settled++; }), /原账号/);
      configureRuleTasks(739);
      accept({ instanceId: "known-instance", task: queued });
      await first;
      configureRuleTasks(owner);
      const failed = terminal(queued, ["failed", "failed", "failed", "failed"]);
      updateRuleTasks(owner, "different-instance", [queued.id], [failed]);
      await assert.rejects(submitRuleTask(api, owner, "wrong instance", actions), /不要重复提交/);
      updateRuleTasks(owner, "known-instance", [queued.id], [{ ...failed, results: failed.results!.slice(0, 3) }]);
      await assert.rejects(submitRuleTask(api, owner, "incomplete results", actions), /不要重复提交/);
      updateRuleTasks(owner, "known-instance", [queued.id], [terminal(queued, ["failed", "unknown", "cancelled", "skipped"])]);
      await assert.rejects(submitRuleTask(api, owner, "unknown row", actions), /不要重复提交/);
      assert.equal(settled, 0);
      assert.equal(submitted.length, 1);
      const mixed = terminal(queued, ["succeeded", "failed", "cancelled", "skipped"]);
      updateRuleTasks(owner, "known-instance", [queued.id], [mixed]);
      assert.equal(settled, 1);
      const recovered = await submitRuleTask(api, owner, "recover original", actions);
      assert.deepEqual(recovered.results, mixed.results);
      assert.equal(submitted.length, 1);
      const retry: RuleTaskAction[] = operation === "createBatch"
        ? [{ ...actions[0], input: { ...actions[0].input, rules: [rows[1]] } }]
        : [actions[1]];
      await submitRuleTask(api, owner, "retry failed", retry);
      assert.deepEqual(submitted[1], retry);
      await submitRuleTask(api, owner, "revisit original", actions);
      await submitRuleTask(api, owner, "revisit successful retry", retry);
      assert.equal(submitted.length, 2, `${operation}: succeeded/cancelled/skipped rows and successful retries stay out of replay`);
    }
  });
});

test("an incomplete terminal response remains unknown even without an account switch", async () => {
  let enqueues = 0;
  let settled = 0;
  const queued = snapshot();
  const task = { ...terminal(queued, ["failed", "failed", "failed"]), results: undefined };
  const actions: RuleTaskAction[] = [{ operation: "restart", input: { id: 750 }, conflictStrategy: "error" }];
  const api = { enqueue: async () => { enqueues++; return { instanceId: "incomplete-instance", task }; },
    lookup: async () => ({ instanceId: "incomplete-instance", task: null }) };
  await assert.rejects(submitRuleTask(api, 750, "incomplete", actions, undefined, () => { settled++; }), /不要重复提交/);
  await assert.rejects(submitRuleTask(api, 750, "no replay", actions), /不要重复提交/);
  assert.equal(enqueues, 1);
  assert.equal(settled, 0);
});

test("a page unmounted before confirmation retains its mixed result for the next page", async () => {
  const queued = { ...snapshot(), total: 4 };
  const mixed = terminal(queued, ["succeeded", "failed", "cancelled", "skipped"]);
  const actions: RuleTaskAction[] = [{ operation: "createBatch", conflictStrategy: "error", input: { rules: [1, 2, 3, 4].map(id => ({ id })) } }];
  let mounted = true;
  let enqueues = 0;
  const api = { enqueue: async () => { enqueues++; return { instanceId: "unmounted-instance", task: enqueues === 1 ? queued : mixed }; },
    lookup: async () => ({ instanceId: "unmounted-instance", task: null }) };
  await submitRuleTask(api, 760, "leaving page", actions, () => {
    queueMicrotask(() => {
      mounted = false;
      updateRuleTasks(760, "unmounted-instance", [queued.id], [mixed]);
    });
  }, () => mounted);
  const recovered = await submitRuleTask(api, 760, "new page", actions);
  assert.deepEqual(recovered.results?.map(result => result.status), ["succeeded", "failed", "cancelled", "skipped"]);
  assert.equal(enqueues, 1, "a result delivered after unmount cannot replay the original input on the new page");
});

test("unknown operations stay blocked across page and account changes without another enqueue", async () => {
  let submits = 0;
  const api = { enqueue: async () => { submits++; throw Error("response lost"); }, lookup: async () => { throw Error("offline"); } };
  for (const operation of ["update", "toggle", "restart", "create", "createBatch"] as const) {
    const actions = [{ operation, input: { id: 7 }, conflictStrategy: "error" }] as RuleTaskAction[];
    await assert.rejects(submitRuleTask(api, 501, "original", actions), /不要重复提交/);
    const accepted = submits;
    configureRuleTasks(502); configureRuleTasks(501);
    await assert.rejects(submitRuleTask(api, 501, "reopened", actions.map(action => ({ ...action, label: "new label" }))), /不要重复提交/);
    assert.equal(submits, accepted, `${operation} must not be replayed with a fresh request ID`);
    await assert.rejects(submitRuleTask(api, 502, "other owner", actions), /不要重复提交/);
    assert.equal(submits, accepted + 1, "the other account has its own attempt boundary");
  }
});

test("tracker recovers same-tab jobs, isolates accounts, detects restart and never replays lost submissions", async () => {
  const saved = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  try {
    const first = snapshot();
    registerRuleTask(101, "instance-1", first);
    assert.equal(ruleTaskTracker.snapshot().length, 1);
    dismissRuleTask(first.id);
    assert.equal(ruleTaskTracker.snapshot().length, 1, "cannot dismiss unfinished work");
    configureRuleTasks(102);
    assert.equal(ruleTaskTracker.snapshot().length, 0);
    configureRuleTasks(101);
    assert.equal(ruleTaskTracker.snapshot()[0].task.id, first.id);
    updateRuleTasks(102, "instance-1", [first.id], [done(first)]);
    assert.equal(ruleTaskTracker.snapshot()[0].task.completed, 0);
    const lost = assert.rejects(waitForRuleTask(101, first.id), /丢失|过期/);
    updateRuleTasks(101, "instance-2", [first.id], [done(first)]);
    await lost;
    assert.equal(ruleTaskTracker.snapshot()[0].lost, true);
    dismissRuleTask(first.id);
    assert.equal(ruleTaskTracker.snapshot().length, 0);

    let submits = 0, lookups = 0;
    const next = snapshot();
    const submission = submitRuleTask({
      enqueue: async input => { submits++; assert.match(input.requestId, /^[\da-f]{32}$/); next.requestId = input.requestId; throw Error("response lost"); },
      lookup: async input => { lookups++; assert.equal(input.requestId, next.requestId); return { instanceId: "instance-2", task: next }; },
    }, 101, "批量导入", [], () => { queueMicrotask(() => updateRuleTasks(101, "instance-2", [next.id], [done(next)])); });
    assert.equal((await submission).succeeded, 3);
    assert.equal(submits, 1); assert.equal(lookups, 1);
    await assert.rejects(submitRuleTask({ enqueue: async () => { submits++; throw Error("offline"); }, lookup: async () => { throw Error("offline"); } }, 101, "批量导入", []), /暂无法确认.*不要重复提交/);
    assert.equal(submits, 2);

    const active = snapshot();
    registerRuleTask(101, "instance-2", active);
    for (let index = 0; index < 25; index++) registerRuleTask(101, "instance-2", done(snapshot()));
    assert.equal(ruleTaskTracker.snapshot().length, 20);
    assert.ok(ruleTaskTracker.snapshot().some(row => row.task.id === active.id), "finished history cannot evict unfinished work");
    assert.doesNotMatch(saved.get(`forwardx.ruleTasks:${ruleTaskScope(101)}`)!, /"results"|"actions"|"token"/);
    const missing = assert.rejects(waitForRuleTask(101, active.id), /丢失/);
    updateRuleTasks(101, "instance-2", [active.id], [null]);
    await missing;

    const previous = snapshot();
    registerRuleTask(103, "instance-2", previous);
    let accept!: (value: { instanceId: string; task: RuleTaskSnapshot }) => void;
    const later = snapshot();
    const switched = submitRuleTask({ enqueue: () => new Promise(resolve => { accept = resolve; }), lookup: async () => ({ instanceId: "instance-2", task: null }) }, 103, "批量导入", []);
    const switchedRejected = assert.rejects(switched, /原账号/);
    configureRuleTasks(104);
    accept({ instanceId: "instance-2", task: later });
    await switchedRejected;
    assert.equal(ruleTaskTracker.snapshot().length, 0);
    configureRuleTasks(103);
    assert.deepEqual(new Set(ruleTaskTracker.snapshot().map(row => row.task.id)), new Set([previous.id, later.id]));
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
