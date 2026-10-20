import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { hostsRouter } from "./routers/hosts";
import { mergeAgentReportedAddress } from "./agentAddressState";
import { scheduleHostDdnsUpdate } from "./hostDdns";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
const originalFetch = globalThis.fetch;
const requests: Array<{ domain: string; recordType: string; value: string; values?: string[]; action?: string }> = [];
const providerRecords = new Map<string, string[]>([["dual.example.com:A", ["1.1.1.1", "9.9.9.9"]]]);
let rejectV6 = false;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://ddns.invalid/replace", "no real provider calls are allowed");
  const body = JSON.parse(String(init?.body)); requests.push(body);
  if (!rejectV6 || body.recordType !== "AAAA") {
    const key = `${body.domain}:${body.recordType}`;
    const previous = providerRecords.get(key) || [];
    providerRecords.set(key, body.action === "replace" ? body.values : [body.value, ...previous.slice(1)]);
  }
  return new Response(rejectV6 && body.recordType === "AAAA" ? "simulated AAAA failure" : "ok", { status: rejectV6 && body.recordType === "AAAA" ? 503 : 200 });
};
async function settled(predicate: (host: any) => boolean) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const host = await db.getHostById(1);
    if (predicate(host)) return host!;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("DDNS update did not converge");
}
async function synchronize(force = false) {
  await db.updateHost(1, { lastDdnsError: "pending test synchronization" });
  scheduleHostDdnsUpdate(await db.getHostById(1), "multi-ip-test", { force });
  return settled(host => host.lastDdnsError === null);
}
try {
  // A pre-feature table must acquire the new nullable inventory/preferences and
  // default primary-only mode through the regular cross-database schema path.
  await runtime.executeRaw('CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ip TEXT NOT NULL, agentToken TEXT, userId INTEGER NOT NULL)');
  await ensureDatabaseSchema();
  for (const id of [1, 2, 3]) await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "test", name: `User ${id}`, role: id === 1 ? "admin" : "user" });
  await runtime.insertAndGetId("hosts", { id: 1, name: "Multi IP", ip: "1.1.1.1", ipv4: "1.1.1.1", ipv6: "2606:4700:4700::1111", ipv4Addresses: '["1.1.1.1","8.8.8.8"]', ipv6Addresses: '["2606:4700:4700::1001","2606:4700:4700::1111"]', agentToken: "test-token", userId: 2 });
  assert.equal((await db.getHostById(1))!.ddnsAddressMode, "primary");
  assert.equal((await db.getHostById(1))!.ddnsRecordSetManaged, false);
  const caller = (id: number, role: string) => hostsRouter.createCaller({ user: { id, role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  const admin = caller(1, "admin"), owner = caller(2, "user"), stranger = caller(3, "user");
  await assert.rejects(stranger.update({ id: 1, preferredIpv4: "8.8.8.8" }), /无权/);
  await assert.rejects(owner.update({ id: 1, preferredIpv4: "9.9.9.9" }), /主 IP/);
  await assert.rejects(owner.update({ id: 1, preferredIpv4: "2606:4700:4700::1111" }), /主 IP/);
  await owner.update({ id: 1, preferredIpv4: "8.8.8.8", preferredIpv6: "2606:4700:4700::1001", ddnsEnabled: true, ddnsAddressMode: "all" });
  let host = (await db.getHostById(1))!;
  assert.equal(host.ipv4, "8.8.8.8"); assert.equal(host.ip, "8.8.8.8"); assert.equal(host.ipv6, "2606:4700:4700::1001");
  assert.equal(host.ddnsEnabled, false); assert.equal(host.ddnsAddressMode, "primary", "only admins may configure DDNS");
  assert.equal(host.ddnsRecordSetManaged, false, "owner input cannot enable complete-record management");
  // Authoritative Agent inventory changes preserve valid selected primaries.
  await db.updateHost(1, mergeAgentReportedAddress({ ipv4: "1.1.1.1", ipv4Addresses: ["8.8.8.8", "1.1.1.1"], ipv6Addresses: ["2606:4700:4700::1001", "2606:4700:4700::1111"] }, host));
  assert.equal((await db.getHostById(1))!.ipv4, "8.8.8.8");
  await db.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "https://ddns.invalid/replace", ddnsWebhookMethod: "POST" });
  // Upgrade and ordinary saves preserve the old single-record webhook contract,
  // including unrelated records that share the same domain and record type.
  await admin.update({ id: 1, ddnsEnabled: true, ddnsDomain: "dual.example.com", ddnsIpVersion: "ipv4", ddnsAddressMode: "primary" });
  host = await settled(item => !!item.lastDdnsAt && !item.lastDdnsError);
  assert.equal(host.ddnsRecordSetManaged, false);
  assert.equal(host.lastDdnsValue, "8.8.8.8");
  assert.equal(requests[0].action, undefined); assert.equal(requests[0].values, undefined);
  assert.deepEqual(providerRecords.get("dual.example.com:A"), ["8.8.8.8", "9.9.9.9"]);
  requests.length = 0;
  await admin.update({ id: 1, name: "Ordinary save", ddnsEnabled: true, ddnsDomain: "dual.example.com", ddnsIpVersion: "ipv4", ddnsAddressMode: "primary" });
  await settled(item => item.lastDdnsError === null && item.name === "Ordinary save");
  assert.equal((await db.getHostById(1))!.ddnsRecordSetManaged, false);
  assert.ok(requests.every(item => item.action === undefined));
  await owner.update({ id: 1, preferredIpv4: "1.1.1.1" });
  await settled(item => item.lastDdnsValue === "1.1.1.1" && !item.lastDdnsError);
  assert.deepEqual(providerRecords.get("dual.example.com:A"), ["1.1.1.1", "9.9.9.9"]);
  await owner.update({ id: 1, preferredIpv4: "8.8.8.8" });
  await settled(item => item.lastDdnsValue === "8.8.8.8" && !item.lastDdnsError);
  requests.length = 0;
  await admin.update({ id: 1, ddnsEnabled: true, ddnsDomain: "dual.example.com", ddnsIpVersion: "both", ddnsAddressMode: "all" });
  host = await settled(item => !!item.lastDdnsAt && !item.lastDdnsError);
  assert.equal(host.ddnsRecordType, "BOTH");
  assert.equal(host.ddnsRecordSetManaged, true);
  assert.deepEqual(requests.map(item => [item.recordType, item.values]), [["A", ["1.1.1.1", "8.8.8.8"]], ["AAAA", ["2606:4700:4700::1001", "2606:4700:4700::1111"]]]);
  assert.deepEqual(providerRecords.get("dual.example.com:A"), ["1.1.1.1", "8.8.8.8"], "explicit new mode owns the selected record set");
  requests.length = 0;
  // Shrinking the inventory replaces the complete set, not just one record.
  await db.updateHost(1, mergeAgentReportedAddress({ ipv4: "1.1.1.1", ipv4Addresses: ["1.1.1.1"], ipv6: "2606:4700:4700::1111", ipv6Addresses: ["2606:4700:4700::1111"] }, host));
  await synchronize();
  assert.deepEqual(requests.map(item => item.values), [["1.1.1.1"], ["2606:4700:4700::1111"]]);
  // Restore aliases, then change to primary-only: stale alias records go away.
  host = (await db.getHostById(1))!;
  await db.updateHost(1, mergeAgentReportedAddress({ ipv4: "1.1.1.1", ipv4Addresses: ["1.1.1.1", "8.8.8.8"], ipv6Addresses: ["2606:4700:4700::1001", "2606:4700:4700::1111"] }, host));
  await synchronize(); requests.length = 0;
  await admin.update({ id: 1, ddnsAddressMode: "primary" });
  host = await settled(item => !!item.lastDdnsAt && !item.lastDdnsError);
  assert.deepEqual(requests.map(item => item.values), [["8.8.8.8"], ["2606:4700:4700::1001"]]);
  // Partial success is persisted; the next attempt retries only AAAA.
  requests.length = 0; rejectV6 = true;
  await db.updateHost(1, { lastDdnsValue: null, lastDdnsError: "pending" });
  scheduleHostDdnsUpdate(await db.getHostById(1), "partial-test");
  host = await settled(item => String(item.lastDdnsError).includes("simulated AAAA failure"));
  assert.deepEqual(JSON.parse(host.lastDdnsValue!), { A: ["8.8.8.8"] });
  assert.deepEqual(requests.map(item => item.recordType), ["A", "AAAA"]);
  requests.length = 0; rejectV6 = false;
  await synchronize();
  assert.deepEqual(requests.map(item => item.recordType), ["AAAA"]);
  // Missing one family must not erase its existing DNS records.
  requests.length = 0;
  await db.updateHost(1, { ipv6: null, ipv6Addresses: "[]", lastDdnsError: "pending" });
  scheduleHostDdnsUpdate(await db.getHostById(1), "missing-family-test");
  await settled(item => String(item.lastDdnsError).includes("No reported IPV6"));
  assert.equal(requests.length, 0);
  assert.ok(requests.every(item => item.action !== "delete"));
  // Changing record type alone is supported by the API too.
  await admin.update({ id: 1, ddnsRecordType: "A" });
  host = await settled(item => !!item.lastDdnsAt && !item.lastDdnsError);
  assert.equal(host.ddnsIpVersion, "ipv4");
  assert.equal(host.ddnsRecordSetManaged, true, "returning to single-stack primary IPs must still remove managed aliases");
  assert.equal(requests.at(-1)?.action, "replace");
  assert.equal((await db.getHostOptions()).find((item: any) => item.id === 1)!.ddnsIpVersion, "ipv4");
  await owner.update({ id: 1, preferredIpv4: null, preferredIpv6: null });
  await settled(item => !item.lastDdnsError);
  assert.equal((await db.getHostById(1))!.preferredIpv4, null);
  const created = await admin.create({ name: "New legacy mode", ip: "8.8.4.4", ddnsEnabled: true, ddnsDomain: "new.example.com", ddnsIpVersion: "ipv4", ddnsAddressMode: "primary" });
  assert.equal((await db.getHostById(created.id))!.ddnsRecordSetManaged, false, "new single-stack hosts also retain single-record semantics");
  await runtime.closeDatabase();
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
  assert.equal((await db.getHostById(1))!.ddnsRecordSetManaged, true, "the record-set decision survives a database reconnect");
} finally {
  globalThis.fetch = originalFetch;
  await runtime.closeDatabase();
}
