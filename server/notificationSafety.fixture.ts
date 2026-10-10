import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { setSettings } from "./repositories/settingsRepository";
import { getUserById, createUser, createTelegramBindCode, createTelegramLoginCode } from "./repositories/userRepository";
import { botAccounts } from "./botAccounts";
import { telegramRouter } from "./routers/telegram";
import { createDiscordCode } from "./discordAccounts";
import { databaseHealth } from "./databaseHealthState";
import { persistSeamlessMigrationState } from "./seamlessMigrationState";
import { discordRequest, startDiscordBot, stopDiscordBot, handleDiscordGatewayDispatch } from "./discordBot";
import { processDiscordBotUpdate, sendTelegramMessage, startTelegramBot, stopTelegramBot } from "./telegramBot";

const actor = "123456789012345678";
const chat = "234567890123456789";
const messageId = "345678901234567890";
const freeze = () => persistSeamlessMigrationState({ version: 1, id: "test-notification", role: "source", phase: "frozen",
  sourceUrl: "https://old.example.test", targetUrl: "https://new.example.test", tokenHash: "a".repeat(64),
  startedAt: Date.now(), expiresAt: Date.now() + 300_000 });

async function protection(userId: number) {
  const originalFetch = globalThis.fetch;
  const originalSocket = globalThis.WebSocket;
  const requests: string[] = [];
  const sockets: FakeGateway[] = [];
  class FakeGateway extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(public url: string) { super(); sockets.push(this); }
    send(_payload: string) {}
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
  }
  globalThis.WebSocket = FakeGateway as unknown as typeof WebSocket;
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return Response.json({ id: chat, bot: true, username: "test" });
  }) as typeof fetch;
  try {
    await createDiscordCode(userId, "DC-PROTECT", new Date(Date.now() + 300_000), "Bind");
    databaseHealth.unavailable({ code: "SQLITE_FULL" });
    await assert.rejects(discordRequest("/users/@me"), /暂停|不可用/);
    await assert.rejects(discordRequest("/users/@me", "GET", undefined, true), /暂停|不可用/);
    await startDiscordBot();
    assert.equal(sockets.length, 0, "unavailable database cannot open the Gateway");
    const update = { update_id: 0, message: { message_id: messageId, chat: { id: chat, type: "private" },
      from: { id: actor }, text: "/bind DC-PROTECT" } };
    await processDiscordBotUpdate(update, async () => { throw new Error("paused update must not reply"); });
    await handleDiscordGatewayDispatch("MESSAGE_CREATE", { id: messageId, channel_id: chat, author: { id: actor }, content: "/bind DC-PROTECT" });
    assert.equal((await getUserById(userId))?.discordId, null);
    assert.equal(requests.length, 0);
    freeze();
    databaseHealth.healthy();
    await startDiscordBot();
    await assert.rejects(discordRequest("/users/@me", "GET", undefined, true), /暂停|不可用/);
    assert.equal(sockets.length, 0, "database recovery must not clear migration protection");
    databaseHealth.unavailable({ code: "SQLITE_FULL" });
    persistSeamlessMigrationState(null);
    await startDiscordBot();
    assert.equal(sockets.length, 0, "migration recovery must not clear database protection");
    databaseHealth.healthy();
    await Promise.all([startDiscordBot(), startDiscordBot()]);
    await startDiscordBot();
    assert.equal(sockets.length, 1, "both protections removed resume only one Gateway");
    stopDiscordBot();

    let retries = 0;
    globalThis.fetch = (async () => {
      retries++;
      databaseHealth.unavailable({ code: "SQLITE_FULL" });
      return Response.json({ retry_after: 0.001 }, { status: 429 });
    }) as typeof fetch;
    await assert.rejects(discordRequest("/retry"), /暂停|不可用/);
    assert.equal(retries, 1, "a retry must recheck protection before sending");
    await setSettings({ notificationChannel: "telegram" });
    await assert.rejects(sendTelegramMessage("1001", "paused notice"), /暂停|不可用/);
    assert.equal(retries, 1);
  } finally {
    stopDiscordBot(); databaseHealth.healthy(); persistSeamlessMigrationState(null);
    globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
  }
}

async function privateTelegram(userId: number) {
  await setSettings({ notificationChannel: "telegram" });
  await createTelegramBindCode(userId, "PRIVATE-BIND", new Date(Date.now() + 300_000));
  const originalFetch = globalThis.fetch;
  const replies: any[] = [];
  let delivered = false;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const pendingPolls: (() => void)[] = [];
  const tgMessage = (text: string, type: string) => ({ message_id: 1, chat: { id: 1001, type }, from: { id: 1001 }, text });
  globalThis.fetch = (async (url, options) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(String(options?.body || "{}"));
    if (method === "getUpdates") {
      if (!delivered) {
        delivered = true;
        return Response.json({ ok: true, result: [
          { update_id: 1, message: tgMessage("/bind PRIVATE-BIND", "group") },
          { update_id: 2, message: tgMessage("/usage", "supergroup") },
          { update_id: 3, callback_query: { id: "group-button", from: { id: 1001 }, message: tgMessage("", "group"), data: "fx:user" } },
          { update_id: 4, message: tgMessage("/menu", "private") },
        ] });
      }
      await new Promise<void>((resolve) => pendingPolls.push(resolve));
      return Response.json({ ok: true, result: [] });
    }
    if (method === "sendMessage" || method === "editMessageText" || method === "answerCallbackQuery") {
      replies.push(body);
      if (method === "sendMessage" && !String(body.text).includes("notification user") && String(body.text).includes("绑定")) finish();
      if (method === "sendMessage" && String(body.text).includes("<b>ForwardX")) finish();
    }
    return Response.json({ ok: true, result: method === "getMe" ? { id: 999, username: "test_bot" } : { message_id: 1 } });
  }) as typeof fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await startTelegramBot();
    await Promise.race([completed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("private menu did not arrive")), 5000); })]);
    assert.equal((await getUserById(userId))?.telegramId, null, "a group cannot consume a binding code");
    assert.equal((await getUserById(userId))?.telegramBindCode, "PRIVATE-BIND");
    assert.equal(replies.length, 1, "only the private menu may produce account output");
  } finally {
    if (timer) clearTimeout(timer);
    stopTelegramBot(); pendingPolls.forEach((resolve) => resolve());
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.fetch = originalFetch;
  }
}

async function telegramLifecycle(userId: number) {
  await setSettings({ notificationChannel: "telegram" });
  await createTelegramBindCode(userId, "STALE-POLL", new Date(Date.now() + 300_000));
  const originalFetch = globalThis.fetch;
  const polls: { complete: (updates: unknown[]) => void }[] = [];
  globalThis.fetch = (async (url) => {
    const method = String(url).split("/").at(-1);
    if (method === "getUpdates") {
      const result = await new Promise<unknown[]>((resolve) => polls.push({ complete: resolve }));
      return Response.json({ ok: true, result });
    }
    return Response.json({ ok: true, result: method === "getMe" ? { id: 999, username: "test_bot" } : { message_id: 1 } });
  }) as typeof fetch;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    await Promise.all([startTelegramBot(), startTelegramBot()]);
    await settle();
    assert.equal(polls.length, 1, "concurrent starts must not create two long polls");
    stopTelegramBot();
    await startTelegramBot();
    await settle();
    assert.equal(polls.length, 2);
    polls[0].complete([{ update_id: 1, message: { message_id: 1, chat: { id: 1001, type: "private" }, from: { id: 1001 }, text: "/bind STALE-POLL" } }]);
    await settle();
    assert.equal(polls.length, 2, "an old poller cannot start polling again after restart");
    assert.equal((await getUserById(userId))?.telegramId, null, "an old response cannot consume a binding code");
    assert.equal((await getUserById(userId))?.telegramBindCode, "STALE-POLL");
  } finally {
    stopTelegramBot(); polls.forEach((poll) => poll.complete([])); await settle(); globalThis.fetch = originalFetch;
  }
}

async function telegramQueue() {
  await setSettings({ notificationChannel: "telegram" });
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  let delivered = 0;
  let blocked = true;
  let releaseSend!: () => void;
  let markSending!: () => void;
  const sending = new Promise<void>(resolve => { markSending = resolve; });
  let releasePoll!: () => void;
  let markResumed!: () => void;
  const resumed = new Promise<void>(resolve => { markResumed = resolve; });
  globalThis.fetch = (async (url, options) => {
    const method = String(url).split("/").at(-1);
    if (method === "getUpdates") {
      const body = JSON.parse(String(options?.body || "{}"));
      requests.push(body);
      if (requests.length <= 2) {
        const result = Array.from({ length: body.limit || 100 }, () => ({ update_id: ++delivered,
          message: { message_id: delivered, chat: { id: 1001, type: "private" }, from: { id: 1001 }, text: "/menu" } }));
        return Response.json({ ok: true, result });
      }
      markResumed();
      await new Promise<void>((resolve) => { releasePoll = resolve; });
      return Response.json({ ok: true, result: [] });
    }
    if (method === "sendMessage" && blocked) { markSending(); await new Promise<void>((resolve) => { releaseSend = resolve; }); }
    return Response.json({ ok: true, result: method === "getMe" ? { id: 999, username: "test_bot" } : { message_id: 1 } });
  }) as typeof fetch;
  try {
    await startTelegramBot();
    await sending;
    assert.equal(delivered, 128, "slow handlers cannot accumulate more than 128 accepted updates");
    assert.equal(requests.length, 2, "a full queue pauses the next long poll");
    assert.equal(requests[0].limit, 100);
    assert.equal(requests[1].limit, 28);
    blocked = false;
    releaseSend();
    await resumed;
    assert.equal(requests.length, 3, "draining resumes polling");
    assert.equal(requests[2].offset, 129, "resume continues after the accepted updates");
    assert.equal(requests[2].limit, 100);
  } finally {
    stopTelegramBot(); releaseSend?.(); releasePoll?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.fetch = originalFetch;
  }
}

async function telegramQueuedProtection(userId: number) {
  await setSettings({ notificationChannel: "telegram" });
  await createTelegramBindCode(userId, "QUEUED-SAFE", new Date(Date.now() + 300_000));
  const originalFetch = globalThis.fetch;
  let delivered = false;
  let releaseSend!: () => void;
  let markSending!: () => void;
  const sending = new Promise<void>(resolve => { markSending = resolve; });
  let releasePoll!: () => void;
  let replies = 0;
  globalThis.fetch = (async (url) => {
    const method = String(url).split("/").at(-1);
    if (method === "getUpdates") {
      if (!delivered) {
        delivered = true;
        return Response.json({ ok: true, result: ["/menu", "/bind QUEUED-SAFE"].map((text, index) => ({
          update_id: index + 1, message: { message_id: index + 1, chat: { id: 1001, type: "private" }, from: { id: 1001 }, text },
        })) });
      }
      await new Promise<void>((resolve) => { releasePoll = resolve; });
      return Response.json({ ok: true, result: [] });
    }
    if (method === "sendMessage") {
      replies++;
      markSending();
      await new Promise<void>((resolve) => { releaseSend = resolve; });
    }
    return Response.json({ ok: true, result: method === "getMe" ? { id: 999, username: "test_bot" } : { message_id: 1 } });
  }) as typeof fetch;
  try {
    await startTelegramBot();
    await sending;
    assert.equal(replies, 1, "the earlier account command is already in flight");
    databaseHealth.unavailable({ code: "SQLITE_FULL" });
    releaseSend();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await getUserById(userId))?.telegramId, null);
    assert.equal((await getUserById(userId))?.telegramBindCode, "QUEUED-SAFE");
    assert.equal(replies, 1, "the queued binding must not reply or execute after database failure");
  } finally {
    stopTelegramBot(); releaseSend?.(); releasePoll?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    databaseHealth.healthy(); globalThis.fetch = originalFetch;
  }
}

async function run() {
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
  await ensureDatabaseSchema();
  const userId = await createUser({ username: "notification-user", password: "test-only-password", name: "notification user" });
  await setSettings({ notificationChannel: "discord", discordBotEnabled: "true", discordBotToken: "dc-test-token",
    discordBotId: "999999999999999999", telegramBotEnabled: "true", telegramBotToken: "tg-test-token", panelPublicUrl: "https://panel.example.test" });
  if (process.argv[2] === "protection") await protection(userId);
  else if (process.argv[2] === "binding") {
    await createTelegramBindCode(userId, "DISABLED-BIND", new Date(Date.now() + 300_000));
    await runtime.executeRaw('UPDATE users SET "accountEnabled" = 0 WHERE id = ?', [userId]);
    await assert.rejects(botAccounts.bind(userId, { id: "1001" }, "DISABLED-BIND"), /绑定码|禁用/);
    assert.equal((await getUserById(userId))?.telegramId, null);
    await runtime.executeRaw('UPDATE users SET "accountEnabled" = 1 WHERE id = ?', [userId]);
    await createTelegramBindCode(userId, "SINGLE-BIND", new Date(Date.now() + 300_000));
    await createTelegramLoginCode(userId, "STALE-LOGIN", new Date(Date.now() + 300_000));
    const attempts = await Promise.allSettled([
      botAccounts.bind(userId, { id: "1001" }, "SINGLE-BIND"),
      botAccounts.bind(userId, { id: "1002" }, "SINGLE-BIND"),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    const bound = await getUserById(userId);
    assert.equal(bound?.telegramId, "1001");
    assert.equal(bound?.telegramBindCode, null);
    assert.equal(bound?.telegramLoginCode, null, "a new binding invalidates old login links");
    await assert.rejects(botAccounts.bind(userId, { id: "1002" }, "SINGLE-BIND"), /绑定码/);
    assert.equal((await getUserById(userId))?.telegramId, "1001");
    await createTelegramBindCode(userId, "EXPIRED-BIND", new Date(Date.now() - 1));
    await assert.rejects(botAccounts.bind(userId, { id: "1002" }, "EXPIRED-BIND"), /过期/);
    assert.equal((await getUserById(userId))?.telegramId, "1001");
  }
  else if (process.argv[2] === "login") {
    const cookies: unknown[] = [];
    const caller = telegramRouter.createCaller({ user: null, req: { headers: {}, ip: "127.0.0.1", protocol: "https", socket: {} } as any,
      res: { cookie: (...args: unknown[]) => cookies.push(args) } as any, authSession: null, authFailureReason: null });
    await runtime.executeRaw('UPDATE users SET "telegramId" = ? WHERE id = ?', ["1001", userId]);
    await createTelegramLoginCode(userId, "CHANNEL-LOGIN", new Date(Date.now() + 300_000));
    await assert.rejects(caller.login({ code: "CHANNEL-LOGIN" }), /未启用/);
    assert.equal(cookies.length, 0);
    assert.equal((await getUserById(userId))?.telegramLoginCode, "CHANNEL-LOGIN", "inactive provider must not consume a code");
    await setSettings({ notificationChannel: "telegram" });
    const result = await caller.login({ code: "CHANNEL-LOGIN" });
    assert.equal(result.id, userId);
    assert.equal("telegramLoginCode" in result, false);
    assert.equal(cookies.length, 1);
    await assert.rejects(caller.login({ code: "CHANNEL-LOGIN" }), /无效/);
    await createTelegramLoginCode(userId, "EXPIRED-LOGIN", new Date(Date.now() - 1));
    await assert.rejects(caller.login({ code: "EXPIRED-LOGIN" }), /过期/);
    await createTelegramLoginCode(userId, "DISABLED-LOGIN", new Date(Date.now() + 300_000));
    await runtime.executeRaw('UPDATE users SET "accountEnabled" = 0 WHERE id = ?', [userId]);
    await assert.rejects(caller.login({ code: "DISABLED-LOGIN" }), /禁用/);
    assert.equal(cookies.length, 1);
  }
  else if (process.argv[2] === "private") await privateTelegram(userId);
  else if (process.argv[2] === "lifecycle") await telegramLifecycle(userId);
  else if (process.argv[2] === "queue") await telegramQueue();
  else if (process.argv[2] === "queued-protection") await telegramQueuedProtection(userId);
  else throw new Error("unknown scenario");
}

run().finally(() => runtime.closeDatabase()).catch((error) => { console.error(error); process.exitCode = 1; });
