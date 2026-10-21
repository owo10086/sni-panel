import assert from "node:assert/strict";
import test from "node:test";
import { RuleLatencyRunner } from "./ruleLatencyRunner";

test("latency retest ignores old completions and prevents duplicate submissions", async () => {
  let release!: (value:any) => void;
  let count = 0;
  const api = {start:async () => ({id:12}),latest:async () => ++count === 1 ? new Promise<any>(resolve => {release = resolve;}) : ({id:12,status:"success",latencyMs:147})};
  const runner = new RuleLatencyRunner(() => {},{pollMs:0,timeoutMs:500});
  const first = runner.start(api);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await runner.start(api),false);
  release({id:11,status:"success",latencyMs:999});
  await first;
  assert.equal(runner.snapshot.result?.latencyMs,147);
  assert.equal(runner.snapshot.phase,"success");
  await runner.start({start:async () => ({id:13}),latest:async () => ({id:13,status:"timeout"})});
  assert.equal(runner.snapshot.phase,"timeout");
  assert.equal(runner.snapshot.result?.id,13);
});

test("a chain batch is matched by batch identity and a configuration change discards pending results", async () => {
  const runner = new RuleLatencyRunner(() => {},{pollMs:0,timeoutMs:500});
  await runner.start({start:async () => ({id:20,batchId:"fc-current"}),latest:async () => ({id:23,batchId:"fc-current",status:"success",latencyMs:188})});
  assert.equal(runner.snapshot.result?.id,23);
  let release!: (value:any) => void;
  const pending = runner.start({start:async () => ({id:24}),latest:() => new Promise(resolve => {release=resolve;})});
  await Promise.resolve(); await Promise.resolve();
  runner.reset();
  release({id:24,status:"success",latencyMs:300});
  await pending;
  assert.equal(runner.snapshot.phase,"idle");
  assert.equal(runner.snapshot.result,null);
});

test("dispatch failures and stalled requests finish with retryable states", async () => {
  const runner = new RuleLatencyRunner(() => {},{pollMs:0,timeoutMs:10});
  await runner.start({start:async () => {throw new Error("offline");},latest:async () => null});
  assert.equal(runner.snapshot.phase,"failed");
  await runner.start({start:() => new Promise(() => {}),latest:async () => null});
  assert.equal(runner.snapshot.phase,"timeout");
  await runner.start({start:async () => ({id:50}),latest:async () => ({id:50,status:"success",latencyMs:40})});
  assert.equal(runner.snapshot.result?.latencyMs,40);
});
