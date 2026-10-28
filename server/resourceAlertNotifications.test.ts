import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-resource-notifications-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "alerts.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.DISCORD_BOT_TOKEN = "";

let runtime: typeof import("./dbRuntime");
let settings: typeof import("./repositories/settingsRepository");
let monitor: typeof import("./operationsMonitor");
let hostsRouter: typeof import("./routers/hosts").hostsRouter;
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; body: any }> = [];
const context = (id: number, role: "admin" | "user") => ({ user: { id, role, username: `fixture-${id}` }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null }) as any;
const token = "isolated-resource-alert-test-token";

before(async () => {
  // This boundary never forwards anything. Real recipient selection, notification
  // rendering and channel adapters run against synthetic identities and tokens.
  globalThis.fetch = (async (url, options) => {
    const body = JSON.parse(String(options?.body || "null"));
    requests.push({ url: String(url), body });
    // Give each synthetic Discord recipient a distinct DM channel so the
    // assertions can match the final rendered message to its actual recipient.
    return Response.json({ ok: true, result: { message_id: 1 }, id: body?.recipient_id || "234567890123456789" });
  }) as typeof fetch;
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  settings = await import("./repositories/settingsRepository");
  monitor = await import("./operationsMonitor");
  hostsRouter = (await import("./routers/hosts")).hostsRouter;
  await import("./telegramBot");
  await import("./discordBot");
  for (let id = 1; id <= 7; id++) await runtime.insertAndGetId("users", {
    id, username: `fixture-${id}`, password: "unused", role: id === 3 ? "user" : "admin", accountEnabled: id !== 4,
    telegramId: [5, 7].includes(id) ? null : String(1000 + id),
    discordId: [5, 6].includes(id) ? null : String(123456789012345670n + BigInt(id)),
  });
  for (const id of [1, 2]) await runtime.insertAndGetId("hosts", { id, name: `Host <${id}>&`, ip: `192.0.2.${id}`, userId: 3 });
  await settings.setSettings({ notificationChannel: "telegram", telegramBotEnabled: "true", telegramBotToken: token, discordBotEnabled: "true", discordBotToken: token });
});

after(async () => {
  // Drain Discord's real 350 ms queue even when an assertion fails, before
  // restoring fetch or closing the isolated database.
  for (let count = 0; count < 40; count++) {
    const previous = requests.length;
    await delay(800);
    if (requests.length === previous) break;
  }
  globalThis.fetch = originalFetch;
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

// observeHostResources intentionally delivers in the background. Preloaded
// adapters plus a bounded event-loop drain also cover the negative assertions.
async function deliveries(expected: number) {
  for (let count = 0; count < 2000 && requests.length < expected; count++) await delay(10);
  await delay(40);
  assert.equal(requests.length, expected, JSON.stringify(requests));
}
const messages = (channel: string) => requests.filter(request => channel === "telegram" ? request.url.endsWith("/sendMessage") : request.url.endsWith("/messages"));
const text = (request: { body: any }, channel: string): string => channel === "telegram" ? request.body.text : request.body.content;
const save = (service: Record<string, unknown>) => hostsRouter.createCaller(context(1, "admin")).saveResourceAlertService({ service } as any);
const baseService = { threshold: 90, enabled: true, notify: true, durationSeconds: 60, recoverySeconds: 30 };

for (const channel of ["telegram", "discord"] as const) {
  test(`${channel}: real resource services deliver scoped overload/recovery only to enabled bound admins`, async t => {
    const staff = hostsRouter.createCaller(context(1, "admin"));
    for (const service of await staff.resourceAlertServices()) await staff.deleteResourceAlertService({ id: service.id });
    await runtime.executeRaw("DELETE FROM operations_alert_events");
    await settings.setSettings({ notificationChannel: channel, [`${channel}BotEnabled`]: "true" });
    requests.length = 0;
    const cpu = await save({ ...baseService, name: "CPU <all>&", metric: "cpu", hostScope: "all" });
    const memory = await save({ ...baseService, name: "Memory specific", metric: "memory", hostScope: "specific", hostIds: [1] });
    const disk = await save({ ...baseService, name: "Disk excluding one", metric: "disk", hostScope: "exclude", excludeHostIds: [1] });
    await assert.rejects(hostsRouter.createCaller(context(3, "user")).saveResourceAlertService({ service: { ...baseService, name: "Forbidden", metric: "cpu" } } as any), { code: "FORBIDDEN" });
    assert.deepEqual((await staff.resourceAlertServices()).map(service => service.id), [cpu.id, memory.id, disk.id]);
    // A host created after saving must be included by all/exclude, not specific.
    const addedHost = channel === "telegram" ? 10 : 11;
    await runtime.insertAndGetId("hosts", { id: addedHost, name: `Host <${addedHost}>&`, ip: `192.0.2.${addedHost}`, userId: 3 });
    const ids = [1, 2, addedHost];
    const now = Math.floor(Date.now() / 1000);
    const sample = async (offset: number, value: number) => {
      for (const id of ids) await monitor.observeHostResources({ id, name: `Host <${id}>&` }, { cpu: value, memory: value, disk: value }, now + offset);
    };
    await sample(0, 95); await sample(30, 95);
    await deliveries(0);
    await sample(60, 95);
    const recipientIds = channel === "telegram" ? ["1001", "1002", "1006"] : ["123456789012345671", "123456789012345672", "123456789012345677"];
    const requestsPerMessage = channel === "telegram" ? 1 : 2;
    await deliveries(ids.length * recipientIds.length * requestsPerMessage);
    const triggered = messages(channel);
    assert.equal(triggered.length, 9);
    if (channel === "telegram") {
      assert.deepEqual([...new Set(triggered.map(request => String(request.body.chat_id)))].sort(), recipientIds);
      assert.ok(triggered.every(request => request.body.parse_mode === "HTML" && request.url === `https://api.telegram.org/bot${token}/sendMessage`));
    } else {
      assert.deepEqual([...new Set(requests.filter(request => request.body?.recipient_id).map(request => request.body.recipient_id))].sort(), recipientIds);
      assert.ok(requests.every(request => request.url.startsWith("https://discord.com/api/")));
    }
    for (const id of ids) {
      const hostMessages = triggered.filter(request => text(request, channel).includes(channel === "telegram" ? `Host &lt;${id}&gt;&amp;` : `Host <${id}>&`));
      assert.equal(hostMessages.length, 3, `host ${id} has exactly one message per eligible admin`);
      assert.deepEqual(hostMessages.map(request => channel === "telegram" ? String(request.body.chat_id) : request.url.split("/channels/")[1].split("/")[0]).sort(), recipientIds);
      for (const request of hostMessages) {
        const content = text(request, channel);
        assert.ok(content.includes(channel === "telegram" ? "CPU &lt;all&gt;&amp;" : "CPU <all>&"));
        assert.equal(content.includes("Memory specific"), id === 1);
        assert.equal(content.includes("Disk excluding one"), id !== 1);
        assert.match(content, /持续超限.*95\.0%/);
      }
    }
    await sample(90, 80);
    await deliveries(9 * requestsPerMessage);
    await sample(120, 80);
    await deliveries(18 * requestsPerMessage);
    const recovered = messages(channel).slice(9);
    assert.equal(recovered.length, 9);
    assert.ok(recovered.every(request => /已恢复.*80\.0%/.test(text(request, channel)) && !text(request, channel).includes("持续超限")));
    for (const id of ids) {
      const hostMessages = recovered.filter(request => text(request, channel).includes(channel === "telegram" ? `Host &lt;${id}&gt;&amp;` : `Host <${id}>&`));
      assert.deepEqual(hostMessages.map(request => channel === "telegram" ? String(request.body.chat_id) : request.url.split("/channels/")[1].split("/")[0]).sort(), recipientIds);
      assert.ok(hostMessages.every(request => text(request, channel).includes("Memory specific") === (id === 1) && text(request, channel).includes("Disk excluding one") === (id !== 1)));
    }
    const events = await runtime.queryRaw<any>("SELECT * FROM operations_alert_events ORDER BY id");
    assert.equal(events.length, 12);
    for (const service of [cpu, memory, disk]) {
      const selectedHosts = service.id === memory.id ? [1] : service.id === disk.id ? [2, addedHost] : ids;
      assert.deepEqual(events.filter(event => event.serviceId === service.id && event.type === "triggered").map(event => Number(event.hostId)).sort((a, b) => a - b), selectedHosts);
      assert.equal(events.filter(event => event.serviceId === service.id && event.type === "recovered").length, selectedHosts.length);
    }
    assert.equal((await runtime.queryRaw<any>("SELECT * FROM resource_alert_service_state")).length, 0);
    t.diagnostic(`SQLite ${(await runtime.queryRaw<any>("SELECT sqlite_version() AS version"))[0].version}; real ${channel} adapter, intercepted fetch only`);
  });

  test(`${channel}: service notify/enabled and channel switches suppress delivery while history remains accurate`, async () => {
    const staff = hostsRouter.createCaller(context(1, "admin"));
    for (const service of await staff.resourceAlertServices()) await staff.deleteResourceAlertService({ id: service.id });
    await runtime.executeRaw("DELETE FROM operations_alert_events");
    requests.length = 0;
    const silent = await save({ ...baseService, name: "Silent CPU", metric: "cpu", hostScope: "specific", hostIds: [1], notify: false });
    const disabled = await save({ ...baseService, name: "Disabled disk", metric: "disk", hostScope: "all", enabled: false });
    const now = Math.floor(Date.now() / 1000) + 300;
    for (const offset of [0, 30, 60, 90, 120]) await monitor.observeHostResources({ id: 1 }, { cpu: offset < 90 ? 95 : 80, disk: 99 }, now + offset);
    await deliveries(0);
    let events = await runtime.queryRaw<any>("SELECT * FROM operations_alert_events");
    assert.deepEqual(events.map(event => [event.serviceId, event.type]), [[silent.id, "triggered"], [silent.id, "recovered"]]);
    await staff.toggleResourceAlertService({ id: silent.id, enabled: false });
    await staff.toggleResourceAlertService({ id: disabled.id, enabled: true });
    await settings.setSetting(`${channel}BotEnabled`, "false");
    for (const offset of [150, 180, 210, 240, 270]) await monitor.observeHostResources({ id: 1 }, { cpu: 99, disk: offset < 240 ? 95 : 80 }, now + offset);
    await deliveries(0);
    events = await runtime.queryRaw<any>("SELECT * FROM operations_alert_events");
    assert.deepEqual(events.slice(2).map(event => [event.serviceId, event.type]), [[disabled.id, "triggered"], [disabled.id, "recovered"]]);
    await settings.setSetting(`${channel}BotEnabled`, "true");
    // Enabling delivery must not replay alerts that occurred while muted.
    await monitor.observeHostResources({ id: 1 }, { disk: 80 }, now + 300);
    await deliveries(0);
  });
}
