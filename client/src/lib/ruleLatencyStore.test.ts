import assert from "node:assert/strict";
import test from "node:test";
import { RuleLatencyStore } from "./ruleLatencyStore";

test("folding a group detaches its subscriber without cancelling or duplicating its rule test", async () => {
  const store = new RuleLatencyStore({pollMs:0,timeoutMs:500});
  store.configure(new Map([[7,"current"]]));
  let release!: (value:any) => void;
  let starts = 0;
  const api = {start:async () => ({id:++starts}),latest:() => new Promise<any>(resolve => {release=resolve;})};
  const detach = store.subscribe(7,() => {});
  const pending = store.start(7,"current",api);
  await Promise.resolve(); await Promise.resolve();
  detach(); // The collapsed group has no mounted row.
  const detachAgain = store.subscribe(7,() => {});
  assert.equal(store.snapshot(7,"current").phase,"testing");
  assert.equal(await store.start(7,"current",api),false);
  assert.equal(starts,1);
  release({id:1,status:"success",latencyMs:147});
  await pending;
  detachAgain();
  assert.equal(store.snapshot(7,"current").result?.latencyMs,147);
  store.dispose();
});

test("a late old batch cannot reenter through refreshed summaries after a configuration change", async () => {
  let now=Date.parse("2026-10-21T04:00:00Z");
  const store=new RuleLatencyStore({pollMs:0,timeoutMs:500},() => now);
  store.configure(new Map([[7,"old-target"]]));
  let release!: (value:any) => void;
  const pending=store.start(7,"old-target",{start:async () => ({id:11,batchId:"fc-old"}),latest:() => new Promise(resolve => {release=resolve;})});
  await Promise.resolve(); await Promise.resolve();
  now+=10_000;
  store.configure(new Map([[7,"new-target"]])); // Also works while the row is folded.
  now+=10_000;
  release({id:13,batchId:"fc-old",status:"success",latencyMs:999});
  await pending;
  const oldSummary={latestLatencyMs:999,latestLatencyAt:new Date(now),latestLatencyStartedAt:new Date(now-20_000)};
  assert.equal(store.snapshot(7,"new-target").phase,"idle");
  assert.equal(store.acceptsSummary(7,"new-target",oldSummary),false);
  assert.equal(store.acceptsSummary(7,"new-target",{latestLatencyMs:999,latestLatencyAt:new Date(now)}),false,
    "a completion time alone cannot prove the result belongs to the new configuration");
  const currentSummary={latestLatencyMs:147,latestLatencyAt:new Date(now+5_000),latestLatencyStartedAt:new Date(now)};
  assert.equal(store.acceptsSummary(7,"new-target",currentSummary),true);
  await store.start(7,"new-target",{start:async () => ({id:14}),latest:async () => ({id:14,status:"success",latencyMs:147})});
  assert.equal(store.snapshot(7,"new-target").result?.latencyMs,147);
  store.reset([7]);
  assert.equal(store.snapshot(7,"new-target").phase,"idle");
  assert.equal(store.acceptsSummary(7,"new-target",oldSummary),false);
  store.dispose();
});
