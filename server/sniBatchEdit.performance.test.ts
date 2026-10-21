import test from "node:test";
import { verifySniWrites } from "./test-support/sniWrites";

for (let run = 1; run <= 3; run++) {
for (const kind of ["failover", "port", "chain", "tunnel"]) {
  test("run " + run + " " + kind + " SNI batches keep 443 across ten same-entry edits and ten entry migrations", () => {
    verifySniWrites(String.raw`
      const kind = ${JSON.stringify(kind)};
      const run = ${run};
      const os = await import("node:os");
      const environment = { platform: process.platform, arch: process.arch, node: process.version, cpus: os.availableParallelism(), os: os.release() };
      await addGroup(30, "entry", [1, 2], { domain: "entry-a.example.test" });
      await addGroup(31, "entry", [5, 6], { domain: "entry-b.example.test" });
      let routes;
      if (kind === "tunnel") {
        for (const [id, entryHostId, exitHostId, entryGroupId] of [[20, 3, 4, 30], [21, 7, 8, 31]]) {
          await insert("tunnels", { id, name: "tunnel-" + id, entryHostId, exitHostId, entryGroupId, mode: "tls", listenPort: 24000 + id, userId: 1, isEnabled: 1 });
        }
        routes = [{ forwardType: "gost", tunnelId: 20 }, { forwardType: "gost", tunnelId: 21 }];
      } else {
        await addGroup(20, kind, kind === "port" ? [3] : kind === "chain" ? [3, 9, 4] : [1, 2], kind === "chain" ? { entryGroupId: 30 } : {});
        await addGroup(21, kind, kind === "port" ? [7] : kind === "chain" ? [7, 10, 8] : [5, 6], kind === "chain" ? { entryGroupId: 31 } : {});
        routes = [{ forwardGroupId: 20 }, { forwardGroupId: 21 }];
      }
      const kept = await create(kind + "-kept", routes[0]);
      const ids = [];
      for (let index = 0; index < 7; index++) ids.push((await create(kind + "-" + index, routes[0])).id);
      const durations = [];
      const batch = async (inputs, label) => {
        const start = performance.now();
        const results = [];
        const stages = inputs.map(input => ({ id: input.id, phase: "waiting" }));
        const report = status => console.log(JSON.stringify({ kind, run, label, status, elapsedMs: performance.now() - start,
          completed: stages.filter(stage => stage.phase === "fulfilled").length, stages, environment }));
        report("started");
        const watchdog = setTimeout(() => { report("timeout"); process.exit(2); }, 5000);
        try {
          // Match the webpage's maximum of six requests in flight.
          for (let offset = 0; offset < inputs.length; offset += 6) {
            results.push(...await Promise.allSettled(inputs.slice(offset, offset + 6).map(async (input, index) => {
              const stage = stages[offset + index];
              stage.phase = "saving";
              try { const result = await admin.update(input); stage.phase = "fulfilled"; return result; }
              catch (error) { stage.phase = "rejected"; stage.error = error.message; throw error; }
            })));
          }
          const elapsed = performance.now() - start;
          durations.push(elapsed);
          report("finished");
          assert.deepEqual(results.map(result => result.status), Array(7).fill("fulfilled"), label + ": " + results.map(result => result.reason?.message || "ok").join("; "));
          assert.ok(elapsed < 5000, label + " exceeded 5 seconds: " + elapsed + "ms");
        } finally { clearTimeout(watchdog); }
      };
      const entryHosts = kind === "port" ? [[3], [7]] : [[1, 2], [5, 6]];
      if (kind === "tunnel") { entryHosts[0].push(3); entryHosts[1].push(7); }
      const originalListeners = new Map();
      if (kind !== "tunnel") for (const hostId of entryHosts[0]) originalListeners.set(hostId, splitters(await heartbeat(hostId)).find(action => action.sourcePort === 443));
      let location = 0;
      for (let round = 0; round < 10; round++) {
        const inputs = ids.map((id, index) => ({ id, targetIp: "203.0.113." + (20 + index), targetPort: 9000 + round * 10 + index, rateLimitMbps: 10 + round + index, maxConnections: 100 + round + index }));
        await batch(inputs, kind + " same-entry round " + round);
        location = 1 - location;
        await batch(ids.map(id => ({ id, ...routes[location] })), kind + " migration round " + round);
        for (const [index, id] of ids.entries()) {
          const saved = await admin.getById({ id });
          assert.equal(Number(saved.sourcePort), 443);
          assert.equal(Number(saved.forwardGroupId || saved.tunnelId), location === 0 ? 20 : 21);
          assert.equal(saved.targetIp, inputs[index].targetIp);
          assert.equal(Number(saved.targetPort), inputs[index].targetPort);
          assert.equal(Number(saved.rateLimitMbps), inputs[index].rateLimitMbps);
          assert.equal(Number(saved.maxConnections), inputs[index].maxConnections);
          if (kind === "tunnel") {
            assert.ok(Number(saved.sniSplitterPort) > 0);
            assert.ok(Number(saved.tunnelExitPort) > 0);
            const stable = { splitter: saved.sniSplitterPort, exit: saved.tunnelExitPort };
            await admin.update({ id, name: "stable-" + round + "-" + index });
            const again = await admin.getById({ id });
            assert.deepEqual({ splitter: again.sniSplitterPort, exit: again.tunnelExitPort }, stable);
          }
        }
        if (kind === "port") {
          const children = await runtime.queryRaw('SELECT id,forwardGroupRuleId,hostId FROM forward_rules WHERE forwardGroupId = ? AND isForwardGroupTemplate = 0 AND pendingDelete = 0', [location === 0 ? 20 : 21]);
          assert.equal(children.length, location === 0 ? 8 : 7, "port member count at round " + round);
        }
        const unchanged = await admin.getById({ id: kept.id });
        assert.equal(Number(unchanged.forwardGroupId || unchanged.tunnelId), 20);
        assert.equal(unchanged.targetPort, 8443);
        if (round === 0 || round === 9) {
          const domains = ids.map((_, index) => kind + "-" + index + ".example.test").sort();
          for (const side of [0, 1]) {
            for (const hostId of kind === "tunnel" ? [] : entryHosts[side]) {
              const actions = splitters(await heartbeat(hostId));
              const listener = actions.find(action => action.sourcePort === 443);
              const expected = [...(side === location ? domains : []), ...(side === 0 ? [kind + "-kept.example.test"] : [])].sort();
              assert.deepEqual((listener?.fxp.sniRoutes || []).map(route => route.sni).sort(), expected, kind + " host " + hostId + " domains");
              if (side === 0) assert.equal(listener.ruleId, originalListeners.get(hostId).ruleId, "moving domains must retain the shared listener identity");
            }
          }
          if (kind === "chain" || kind === "tunnel") {
            const hostId = location === 0 ? 4 : 8;
            const exitRoutes = splitters(await heartbeat(hostId)).flatMap(action => action.fxp.sniRoutes);
            for (const [index, domain] of ids.map((_, index) => kind + "-" + index + ".example.test").entries()) {
              const route = exitRoutes.find(route => route.sni === domain);
              assert.ok(route, "missing exit domain " + domain);
              assert.equal(route.targetIp, inputs[index].targetIp);
              assert.equal(Number(route.targetPort), inputs[index].targetPort);
              assert.equal(Number(route.maxConnections), inputs[index].maxConnections);
            }
          }
        }
        await within(settings.setSetting("matrixProgress", kind + "-" + round), "write after batch");
      }
      console.log(JSON.stringify({ kind, batches: durations.length, rulesPerBatch: 7, concurrency: 6, port: 443, longestBatchMs: Math.ceil(Math.max(...durations)), limitMs: 5000 }));
    `);
  });
}

}
