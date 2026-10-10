import assert from "node:assert/strict";
import { mock } from "node:test";
import * as runtime from "../dbRuntime";
import { ensureDatabaseSchema } from "../dbSchema";
import { setSettings } from "../repositories/settingsRepository";
import { getUserById } from "../repositories/userRepository";
import * as store from "./workflowStore";

const provider = process.env.WORKFLOW_PROVIDER === "telegram" ? "telegram" : "discord";
const scope: store.BotScope = { provider, chatId: provider === "telegram" ? 1001 : "234567890123456789", actorUserId: 1 };
const actorId = provider === "telegram" ? 1001 : "123456789012345679";
const customerId = provider === "telegram" ? 1002 : "123456789012345680";
const identityColumn = provider === "telegram" ? "telegramId" : "discordId";
const pollQueue: any[] = [];
let pollWake: (() => void) | undefined;
let updateId = 0;
const phase = process.argv[2];
const replies: any[] = [];
const requests: any[] = [];
globalThis.fetch = (async (_url, init) => {
  if (String(_url).startsWith("https://discord.com/api/v10/")) {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.content && !String(_url).includes("/interactions/")) replies.push({ method: "gatewayReply", body: { text: body.content, reply_markup: body.components } });
    return Response.json({ id: "345678901234567890", username: "test_bot" });
  }
  if (String(_url).startsWith("https://api.telegram.org/")) {
    const method = String(_url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body || "{}"));
    if (method === "getUpdates") {
      if (!pollQueue.length) await new Promise<void>(resolve => { pollWake = resolve; });
      pollWake = undefined;
      return Response.json({ ok: true, result: pollQueue.splice(0) });
    }
    if (["sendMessage", "editMessageText"].includes(method)) { assert.ok(body.text.length <= 4096, "Telegram output stays within its message limit"); replies.push({ method, body }); }
    return Response.json({ ok: true, result: method === "getMe" ? { id: 999, username: "test_bot" } : { message_id: 1 } });
  }
  const body = JSON.parse(String(init?.body));
  requests.push(body);
  const text = body.messages[1].content;
  if (["调整插件开关", "打开它", "再关闭插件", "哪些规则快到期了"].includes(text)) {
    const response = text === "哪些规则快到期了"
      ? { kind: "query", goal: "查看规则所属账户即将到期", confidence: 0.95, query: { intent: "panel_query", tool: "expiry.list", input: { resource: "rules", days: 7 } } }
      : { kind: "manage", goal: "调整插件功能", confidence: 0.95, actions: [{ action: "panel_operation", tool: "settings.set", input: text === "调整插件开关" ? { key: "pluginsEnabled" } : text === "打开它" ? { value: true } : { key: "pluginsEnabled", value: false } }, ...(text === "调整插件开关" ? [{ action: "panel_operation", tool: "settings.set", input: { key: "allowMultiDeviceLogin", value: true } }] : [])] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
  }
  if (text === "读取上下文") {
    const response = body.messages[2].content.includes('"observations":[]')
      ? { kind: "context", goal: "读取用户元数据", confidence: 0.95, tools: [{ name: "users", keyword: "张三" }] }
      : { kind: "query", goal: "查询账户", confidence: 0.95, query: { intent: "account" } };
    return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
  }
  const response = text.includes("50") ? { kind: "manage", goal: "充值并续费", confidence: 0.95, actions: [{ action: "balance_adjust", target: "2", amountYuan: 50 }] }
    : text.includes("个月") ? { kind: "manage", goal: "续费", confidence: 0.95, actions: [{ action: "renew", target: "2", durationValue: 1, durationUnit: "month" }] }
    : { kind: "manage", goal: "给张三充值并续费", confidence: 0.95, actions: [{ action: "balance_adjust", target: "2" }, { action: "renew", target: "2" }] };
  return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
}) as typeof fetch;
const { processDiscordBotUpdate, startTelegramBot, stopTelegramBot } = await import("../telegramBot");
const db = await import("../db");
const { discordComponents, handleDiscordGatewayDispatch, discordConnectionStatus } = await import("../discordBot");
const gateway = async (event: string, data: any) => {
  await handleDiscordGatewayDispatch(event, data);
  const deadline = Date.now() + 10000;
  while (discordConnectionStatus().queued) {
    if (Date.now() > deadline) throw new Error("Gateway workflow did not finish");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const api = async (method: string, body?: Record<string, unknown>) => {
  replies.push({ method, body }); return { message_id: "345678901234567890" };
};
const from = { id: actorId, username: "admin", language_code: phase.startsWith("english") ? "en" : "zh" };
const msg = { message_id: "345678901234567891", chat: { id: scope.chatId, type: "private" } };
const dispatch = async (update: any) => {
  if (provider === "discord") return processDiscordBotUpdate(update, api);
  const before = replies.length;
  pollQueue.push({ ...update, update_id: ++updateId });
  pollWake?.();
  const deadline = Date.now() + 5000;
  while (replies.length === before) {
    if (Date.now() > deadline) throw new Error("Telegram workflow reply timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Allow additional progress/result messages from the same business operation.
  await new Promise(resolve => setTimeout(resolve, 50));
};
const message = (text: string) => dispatch({ update_id: 0, message: { ...msg, from, text } });
const callback = (data: string) => dispatch({ update_id: 0, callback_query: { id: "test-callback", from, message: msg, data } });

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
try {
  await ensureDatabaseSchema();
  if (provider === "telegram") {
    await setSettings({ notificationChannel: "telegram", telegramBotEnabled: "true", telegramBotToken: "test-token" });
    await startTelegramBot();
  }
  if (phase === "start") {
    await runtime.executeRaw(`INSERT INTO users (id,username,password,name,role,"accountEnabled","${identityColumn}") VALUES (1,?,?,?,'admin',1,?)`, ["admin", "never-send-password", "管理员", String(from.id)]);
    await runtime.executeRaw('INSERT INTO users (id,username,password,name,role,"accountEnabled") VALUES (2,?,?,?,\'user\',1)', ["customer", "private-password", "张三"]);
    await setSettings({ notificationChannel: provider, discordBotEnabled: "true", discordBotToken: "test-token", discordBotId: "999999999999999999", deepseekAiEnabled: "true", deepseekApiKey: "test-key", telegramAiAutoRecallEnabled: "false" });
    // No old write keyword is needed to let the planner understand this goal.
    await message("让张三继续用下去，顺便充点钱");
    const draft = await store.readBotDraft<any>(scope);
    assert.ok(draft, JSON.stringify(replies));
    assert.equal(draft.intent.action, "balance_adjust");
    assert.equal(draft.intent.target, "2");
    assert.equal(draft.remainingIntents[0].action, "renew");
    assert.ok(draft.missingFields.includes("amountYuan"));
    assert.equal((await getUserById(2))?.balanceCents, 0);
    assert.ok(requests.length > 0);
    assert.equal(await store.readBotDraft({ ...scope, provider: provider === "discord" ? "telegram" : "discord" }), null);
    assert.equal(await store.readBotDraft({ ...scope, actorUserId: 2 }), null);
    assert.equal(await store.readBotDraft({ ...scope, chatId: "other-chat" }), null);
  } else if (phase === "supplement") {
    // New process: original parameters, missing fields and remaining steps survive.
    await message("50元");
    const draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.intent.amountYuan, 50);
    assert.equal(draft.intent.target, "2");
    assert.equal(draft.stage, "confirming");
    const action = await store.readBotAction<any>(scope, draft.confirmationKey);
    assert.equal(action?.payload.amountCents, 5000);
    assert.equal((await getUserById(2))?.balanceCents, 0);
    // Simulate an expired approval without erasing the persisted draft.
    await runtime.executeRaw('UPDATE ai_bot_workflows SET payload = ? WHERE id = ?', [JSON.stringify({ ...action!.payload, expiresAt: Date.now() - 1 }), action!.id]);
  } else if (phase === "confirm") {
    const previous = await store.readBotDraft<any>(scope);
    await message("继续");
    const draft = await store.readBotDraft<any>(scope);
    assert.notEqual(draft.confirmationKey, previous.confirmationKey);
    await callback(`fx:op:confirm:${previous.confirmationKey}`);
    assert.equal((await getUserById(2))?.balanceCents, 0);
    await callback("fx:menu");
    assert.equal((await store.readBotDraft<any>(scope)).confirmationKey, draft.confirmationKey);
    await Promise.all([callback(`fx:op:confirm:${draft.confirmationKey}`), callback(`fx:op:confirm:${draft.confirmationKey}`)]);
    assert.equal((await getUserById(2))?.balanceCents, 5000);
    const next = await store.readBotDraft<any>(scope);
    assert.equal(next.action, "renew");
    assert.deepEqual(next.completedActions, ["balance_adjust"]);
    assert.ok(next.missingFields.includes("duration"));
    assert.equal((await store.readBotAction(scope, draft.confirmationKey))?.status, "succeeded");
  } else if (phase === "finish") {
    await message("继续");
    assert.match(replies.at(-1).body.text, /已完成结果/);
    assert.match(replies.at(-1).body.text, /50\.00/);
    assert.match(replies.at(-1).body.text, /待处理/);
    await message("1个月");
    const draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.intent.target, "2");
    assert.equal(draft.intent.durationValue, 1);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal(await store.readBotDraft(scope), null);
    assert.ok((await getUserById(2))?.expiresAt);
    assert.equal((await getUserById(2))?.balanceCents, 5000);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await getUserById(2))?.balanceCents, 5000);
  } else if (phase === "security") {
    await message("读取上下文");
    assert.ok(requests.some((request) => request.messages[2].content.includes('"name":"张三"')));
    const customerDiscordId = customerId;
    await runtime.executeRaw(`UPDATE users SET "${identityColumn}" = ? WHERE id = 2`, [String(customerDiscordId)]);
    await dispatch({ update_id: 0, message: { ...msg, from: { id: customerDiscordId }, text: "给自己充值50" } });
    assert.equal((await getUserById(2))?.balanceCents, 5000);
    const denied = await store.readBotDraft<any>({ ...scope, actorUserId: 2 });
    assert.equal(denied.confirmationKey, undefined, "unauthorized write never gets an approval token");
    await message("50元");
    const draft = await store.readBotDraft<any>(scope);
    assert.ok(draft.confirmationKey);
    // Losing admin rights between preview and confirm must stop the write.
    await runtime.executeRaw('UPDATE users SET role = \'user\' WHERE id = 1');
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await getUserById(2))?.balanceCents, 5000);
    assert.equal((await store.readBotAction(scope, draft.confirmationKey))?.status, "rejected", "permission loss is rejected before any business write");
    await message("取消");
    await runtime.executeRaw('UPDATE users SET role = \'admin\' WHERE id = 1');
  } else if (phase === "claim") {
    const token = await store.createBotAction(scope, { action: "balance_adjust", amountCents: 99 });
    await store.saveBotDraft(scope, { confirmationKey: token, sourceText: "test interrupted write", goal: "检查中断恢复", completedActions: [] });
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimBotAction(scope, token)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await store.claimBotAction({ ...scope, provider: provider === "discord" ? "telegram" : "discord" }, token), null);
  } else if (phase === "uncertain") {
    const draft = await store.readBotDraft<any>(scope);
    assert.equal((await store.readBotAction(scope, draft.confirmationKey))?.status, "executing");
    assert.equal(await store.claimBotAction(scope, draft.confirmationKey), null);
    await message("继续");
    assert.ok(replies.some((reply) => String(reply.body?.text).includes("不会自动重试")));
    assert.equal((await getUserById(2))?.balanceCents, 5000);
    await message("取消");
    assert.equal(await store.readBotDraft(scope), null);
    assert.equal((await store.readBotAction(scope, draft.confirmationKey))?.status, "executing", "cancel never mislabels a submitted write as rolled back");
  } else if (phase === "panel_start") {
    await setSettings({ pluginsEnabled: "false" });
    await message("调整插件开关");
    const draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.intent.tool, "settings.set");
    assert.equal(draft.intent.input.key, "pluginsEnabled");
    assert.ok(draft.missingFields.includes("panelInput"));
    assert.equal(draft.confirmationKey, undefined);
  } else if (phase === "panel_finish") {
    await message("打开它");
    const draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.intent.input.key, "pluginsEnabled");
    assert.equal(draft.intent.input.value, true);
    const action = await store.readBotAction<any>(scope, draft.confirmationKey);
    assert.equal(action!.payload.panelCall.tool, "settings.set");
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    const next = await store.readBotDraft<any>(scope);
    assert.equal(next.intent.input.key, "allowMultiDeviceLogin");
    assert.equal(next.completedActions[0], "settings.set");
    await callback(`fx:op:confirm:${next.confirmationKey}`);
    assert.equal(await store.readBotDraft(scope), null);
    assert.equal((await runtime.queryRaw<any>("SELECT value FROM system_settings WHERE key = 'pluginsEnabled'"))[0].value, "true");
    await message("哪些规则快到期了");
    assert.ok(replies.some(r => String(r.body?.text || "").includes("所属账户")));
    await message("再关闭插件");
    const stale = await store.readBotDraft<any>(scope);
    await setSettings({ pluginsEnabled: "false" });
    await callback(`fx:op:confirm:${stale.confirmationKey}`);
    assert.equal((await store.readBotAction(scope, stale.confirmationKey))?.status, "rejected");
    assert.ok(await store.readBotDraft(scope));
    await message("继续");
    const refreshed = await store.readBotDraft<any>(scope);
    assert.notEqual(refreshed.confirmationKey, stale.confirmationKey);
    await callback(`fx:op:confirm:${refreshed.confirmationKey}`);
    assert.equal(await store.readBotDraft(scope), null);
  } else if (phase === "wizard_start") {
    await runtime.executeRaw(`INSERT INTO hosts (id,name,ip,"userId","agentVersion","isOnline","lastHeartbeat") VALUES (1,'entry','192.0.2.1',1,'2.2.190',1,?),(2,'exit','192.0.2.2',1,'2.2.190',1,?)`, [Math.floor(Date.now()/1000), Math.floor(Date.now()/1000)]);
    for (let i = 0; i < 12; i++) {
      await runtime.executeRaw(`INSERT INTO forward_groups (id,name,"groupMode","groupType",domain,"targetIp","userId") VALUES (?,?,'port','host','','0.0.0.0',1)`, [100 + i, `Port Link ${i}`]);
      await runtime.executeRaw(`INSERT INTO forward_group_members ("groupId","memberType","hostId") VALUES (?,'host',1)`, [100 + i]);
    }
    await runtime.executeRaw(`INSERT INTO tunnels (id,name,"entryHostId","exitHostId","listenPort","userId",secret) VALUES (20,'Tunnel Link',1,2,24443,1,'never-send-tunnel-secret')`);
    await message("帮我添加转发规则到目标10.10.10.10:22");
    let draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.intent.tool, "rules.create");
    assert.equal(draft.intent.input.targetIp, "10.10.10.10"); assert.equal(draft.intent.input.targetPort, 22);
    assert.equal(draft.intent.input.sourcePort, undefined);
    assert.equal(draft.selection.field, "route"); assert.equal(draft.selection.pages, 2);
    const markup = replies.at(-1).body.reply_markup;
    assert.ok(discordComponents(markup).length <= 5);
    for (const button of markup.inline_keyboard.flat()) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    const staleKey = draft.selection.key;
    await callback(`fx:op:choose:${staleKey}:page:1`);
    draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.selection.page, 1); assert.notEqual(draft.selection.key, staleKey);
    assert.ok(draft.selection.choices.some((c: any) => c.input.tunnelId === 20));
    await callback(`fx:op:choose:${staleKey}:0`);
    assert.equal((await store.readBotDraft<any>(scope)).selection.key, draft.selection.key);
    await message("继续");
    draft = await store.readBotDraft<any>(scope);
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.intent.input.forwardGroupId, 100);
    assert.equal(draft.selection.field, "sourcePort");
    assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM forward_rules"))[0].count, 0);
    assert.equal(requests.length, 0, "simple creation and button navigation need no model round trips");
  } else if (phase === "wizard_finish") {
    // A new process resumes the selected link and original target without guessing.
    await message("24322");
    let draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.intent.input.sourcePort, 24322);
    assert.equal(draft.intent.input.targetPort, 22);
    assert.equal(draft.selection.field, "protocol");
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.stage, "confirming");
    const action = await store.readBotAction<any>(scope, draft.confirmationKey);
    assert.equal(action!.payload.panelCall.input.protocol, "tcp");
    assert.equal(action!.payload.panelCall.input.forwardGroupId, 100);
    assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM forward_rules"))[0].count, 0);
    await Promise.all([callback(`fx:op:confirm:${draft.confirmationKey}`), callback(`fx:op:confirm:${draft.confirmationKey}`)]);
    assert.equal(await store.readBotDraft(scope), null);
    const roots = await runtime.queryRaw<any>(`SELECT * FROM forward_rules WHERE "forwardGroupRuleId" IS NULL`);
    assert.equal(roots.length, 1); assert.equal(roots[0].sourcePort, 24322);
    assert.equal(roots[0].targetIp, "10.10.10.10"); assert.equal(roots[0].targetPort, 22);
  } else if (phase === "wizard_tunnel") {
    await message("帮我添加转发规则到目标10.10.10.10:443");
    let draft = await store.readBotDraft<any>(scope);
    await callback(`fx:op:choose:${draft.selection.key}:page:1`);
    draft = await store.readBotDraft<any>(scope);
    const tunnelIndex = draft.selection.choices.findIndex((c: any) => c.input.tunnelId === 20);
    assert.ok(tunnelIndex >= 0);
    await callback(`fx:op:choose:${draft.selection.key}:${tunnelIndex}`);
    draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.selection.field, "sourcePort");
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.selection.field, "protocol");
    await callback(`fx:op:choose:${draft.selection.key}:2`);
    draft = await store.readBotDraft<any>(scope);
    const action = await store.readBotAction<any>(scope, draft.confirmationKey);
    assert.equal(action!.payload.panelCall.input.forwardType, "gost");
    assert.equal(action!.payload.panelCall.input.sourcePort, 0);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await store.readBotAction(scope, draft.confirmationKey))!.status, "succeeded");
    const rules = await runtime.queryRaw<any>(`SELECT * FROM forward_rules WHERE "tunnelId"=20 AND "forwardGroupRuleId" IS NULL`);
    assert.equal(rules.length, 1); assert.equal(rules[0].forwardType, "gost");
    assert.equal(rules[0].targetPort, 443); assert.ok(rules[0].sourcePort > 0);
  } else if (phase === "wizard_permissions") {
    const customerFrom = { id: customerId };
    const customerScope = { ...scope, actorUserId: 2 };
    await store.clearBotDraft(customerScope);
    await runtime.executeRaw(`UPDATE users SET "${identityColumn}"=?,"canAddRules"=1,"manualCanAddRules"=1 WHERE id=2`, [String(customerFrom.id)]);
    await db.setUserForwardGroupPermissions(2, [100]);
    const customerMessage = (text: string) => dispatch({ update_id: 0, message: { ...msg, from: customerFrom, text } });
    const customerClick = (data: string) => dispatch({ update_id: 0, callback_query: { id: "customer-click", from: customerFrom, message: msg, data } });
    await customerMessage("帮我添加转发规则到目标10.10.10.10:22");
    let draft = await store.readBotDraft<any>(customerScope);
    assert.equal(draft.selection.choices.length, 1);
    assert.equal(draft.selection.choices[0].input.forwardGroupId, 100);
    // Even one available link must be explicitly selected.
    const key = draft.selection.key;
    await db.setUserForwardGroupPermissions(2, []);
    await customerClick(`fx:op:choose:${key}:0`);
    draft = await store.readBotDraft<any>(customerScope);
    assert.equal(draft.confirmationKey, undefined); assert.equal(draft.selection.choices.length, 0);
    assert.equal(draft.intent.input.forwardGroupId, undefined);
    assert.equal((await runtime.queryRaw<any>(`SELECT COUNT(*) AS count FROM forward_rules WHERE "userId"=2`))[0].count, 0);
    await customerClick(`fx:op:choose:${draft.selection.key}:cancel`);
    assert.equal(await store.readBotDraft(customerScope), null);
    assert.ok(!JSON.stringify(replies).includes("never-send-tunnel-secret"));
  } else if (phase === "wizard_settings") {
    await message("调整插件开关");
    let draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.selection.field, "value");
    assert.deepEqual(draft.selection.choices.map((c: any) => c.input.value), [true, false]);
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.equal(draft.stage, "confirming");
    assert.equal((await db.getAllSettings()).pluginsEnabled, "false");
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await db.getAllSettings()).pluginsEnabled, "true");
    draft = await store.readBotDraft<any>(scope);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal(await store.readBotDraft(scope), null);
  } else if (phase === "menu_renew") {
    const buttons = () => replies.at(-1).body.reply_markup.inline_keyboard.flat();
    const beforeCancel = (await getUserById(2))!.expiresAt!.getTime();
    await callback("fx:admin:renew:2:0");
    const cancelled = buttons().find((b: any) => b.callback_data.startsWith("fx:admin:renew:confirm:"));
    await callback(buttons().find((b: any) => b.text.includes("取消")).callback_data);
    await callback(cancelled.callback_data);
    assert.equal((await getUserById(2))!.expiresAt!.getTime(), beforeCancel, "cancelled menu approvals cannot renew later");
    await message("/renew 2");
    const replaced = buttons().find((b: any) => b.callback_data.startsWith("fx:admin:renew:confirm:"));
    await callback("fx:admin:renew:2:0");
    const confirm = replies.at(-1).body.reply_markup.inline_keyboard.flat().find((button: any) => button.callback_data.startsWith("fx:admin:renew:confirm:"));
    assert.ok(confirm);
    await callback(replaced.callback_data);
    assert.equal((await getUserById(2))!.expiresAt!.getTime(), beforeCancel, "opening a new preview invalidates the old command approval");
    await callback(confirm.callback_data);
    const afterOnce = (await getUserById(2))!.expiresAt!.getTime();
    await callback(confirm.callback_data);
    assert.equal((await getUserById(2))!.expiresAt!.getTime(), afterOnce, "a repeated menu approval must not extend the account twice");
    await message("/renew 2");
    const renewalScope = { ...scope, chatId: `renewal:${scope.chatId}` };
    const expired = await store.readBotDraft<any>(renewalScope);
    const expiredAction = await store.readBotAction<any>(renewalScope, expired.confirmationKey);
    await runtime.executeRaw('UPDATE ai_bot_workflows SET payload=? WHERE id=?', [JSON.stringify({ ...expiredAction!.payload, expiresAt: Date.now() - 1 }), expired.confirmationKey]);
    await callback(`fx:admin:renew:confirm:${expired.confirmationKey}:0`);
    assert.equal((await getUserById(2))!.expiresAt!.getTime(), afterOnce, "expired command approval cannot renew");
    await message("/renew 2");
  } else if (phase === "menu_restart") {
    const renewalScope = { ...scope, chatId: `renewal:${scope.chatId}` };
    const saved = await store.readBotDraft<any>(renewalScope);
    const approval = await store.readBotAction<any>(renewalScope, saved.confirmationKey);
    await callback(`fx:admin:renew:confirm:${saved.confirmationKey}:0`);
    assert.equal((await getUserById(2))!.expiresAt!.getTime(), Math.floor(approval!.payload.nextExpiresAt / 1000) * 1000, "command renewal survives a real process restart");
    await callback(`fx:admin:renew:confirm:${saved.confirmationKey}:0`);
    assert.equal((await getUserById(2))!.expiresAt!.getTime(), Math.floor(approval!.payload.nextExpiresAt / 1000) * 1000);
  } else if (phase === "english_wizard") {
    const source = "add forwarding rule to 203.0.113.90:443";
    await message(source);
    let draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /Choose.*tunnel|Choose.*forwarding/);
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /listening port/);
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /protocol/);
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /Operation confirmation/);
    assert.match(replies.at(-1).body.text, /Target address/);
    assert.ok(replies.at(-1).body.text.includes(source));
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.match(replies.at(-1).body.text, /Completed/);
    await message("调整插件开关");
    draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /Choose/);
    assert.match(replies.at(-1).body.reply_markup.inline_keyboard[0][0].text, /Enable/);
    await callback(`fx:op:choose:${draft.selection.key}:0`);
    draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /Plugins/);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    draft = await store.readBotDraft<any>(scope);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    await message("让张三继续用下去，顺便充点钱");
    assert.match(replies.at(-1).body.text, /Choose.*amount/);
    const amount = replies.at(-1).body.reply_markup.inline_keyboard.flat().find((b: any) => b.text.includes("50"));
    await callback(amount.callback_data);
    draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /Current balance/);
    assert.ok(replies.at(-1).body.text.includes("张三"));
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.match(replies.at(-1).body.text, /Choose.*duration/);
    const duration = replies.at(-1).body.reply_markup.inline_keyboard.flat().find((b: any) => b.text === "1 month");
    await callback(duration.callback_data);
    draft = await store.readBotDraft<any>(scope);
    assert.match(replies.at(-1).body.text, /expiry|Expiry/);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.match(replies.at(-1).body.text, /New expiry/);
    assert.ok(replies.at(-1).body.text.includes("张三"));
    // Restore the known starting balance for the following independent cases.
    await runtime.executeRaw('UPDATE users SET "balanceCents"=5000 WHERE id=2');
  } else if (phase === "gateway_english_start") {
    if (provider === "discord") {
      await gateway("INTERACTION_CREATE", { id: "456789012345678901", application_id: "999999999999999999", type: 2,
        token: "test_interaction_token", channel_id: scope.chatId, user: { id: actorId, username: "admin" }, locale: "en-US",
        data: { name: "ask", options: [{ name: "args", value: "add forwarding rule to 203.0.113.94:443" }] } });
      assert.match(replies.at(-1).body.text, /Choose.*forwarding/);
      assert.ok((await store.readBotDraft<any>(scope)).selection);
    }
  } else if (phase === "gateway_english_finish") {
    if (provider === "discord") {
      await gateway("MESSAGE_CREATE", { id: "456789012345678902", channel_id: scope.chatId,
        author: { id: actorId, username: "admin" }, content: "resume" });
      assert.match(replies.at(-1).body.text, /Choose.*forwarding/);
      assert.ok(replies.at(-1).body.text.includes("203.0.113.94"));
      await gateway("MESSAGE_CREATE", { id: "456789012345678903", channel_id: scope.chatId,
        author: { id: actorId, username: "admin" }, content: "cancel" });
      assert.match(replies.at(-1).body.text, /submitted|completed/);
    }
  } else if (phase === "english_partial_start") {
    await message("让张三继续用下去，顺便充点钱");
    await message("50元");
    let draft = await store.readBotDraft<any>(scope);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await getUserById(2))!.balanceCents, 10000);
    await message("1个月");
    draft = await store.readBotDraft<any>(scope);
    const { appRouter } = await import("../routers");
    const admin = appRouter.createCaller({ user: (await getUserById(1))!, authSession: null, authFailureReason: null,
      req: { headers: {}, socket: {}, protocol: "https", get: () => undefined }, res: { clearCookie: () => undefined } } as any);
    await admin.users.updateTrafficSettings({ userId: 2, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await store.readBotAction(scope, draft.confirmationKey))!.status, "rejected");
    assert.match(replies.at(-1).body.text, /Not executed/);
    assert.equal((await getUserById(2))!.balanceCents, 10000);
  } else if (phase === "english_partial_resume") {
    await message("resume");
    assert.match(replies.at(-1).body.text, /Completed results/);
    assert.match(replies.at(-1).body.text, /50\.00/);
    assert.match(replies.at(-1).body.text, /Pending/);
    const draft = await store.readBotDraft<any>(scope);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.match(replies.at(-1).body.text, /New expiry/);
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await getUserById(2))!.balanceCents, 10000, "resuming a failed second step never repeats the completed top-up");
    await runtime.executeRaw('UPDATE users SET "balanceCents"=5000 WHERE id=2');
  } else if (phase === "resume_preview") {
    await message("让张三继续用下去，顺便充点钱");
    const oldChoice = replies.at(-1).body.reply_markup.inline_keyboard.flat().find((b: any) => b.text.includes("50"));
    assert.ok(oldChoice);
    await message("取消");
    await message("让张三继续用下去，顺便充点钱");
    await callback(oldChoice.callback_data);
    const untouched = await store.readBotDraft<any>(scope);
    assert.equal(untouched.intent.amountYuan, undefined, "an old amount button cannot fill a new draft");
    assert.equal(untouched.confirmationKey, undefined);
    await message("50元");
    const old = await store.readBotDraft<any>(scope);
    const balanceLine = replies.at(-1).body.text.match(/当前余额：[^\n]+/)[0];
    await message("继续");
    assert.match(replies.at(-1).body.text, /目标用户：#2/);
    assert.ok(replies.at(-1).body.text.includes(balanceLine), "resume must show the same real target balance");
    const refreshed = await store.readBotDraft<any>(scope);
    assert.notEqual(refreshed.confirmationKey, old.confirmationKey);
    await callback(`fx:op:confirm:${old.confirmationKey}`);
    assert.equal((await getUserById(2))!.balanceCents, 5000);
    await callback(`fx:op:confirm:${refreshed.confirmationKey}`);
    assert.equal((await getUserById(2))!.balanceCents, 10000);
  } else if (phase === "legacy_stale") {
    await message("1个月");
    const draft = await store.readBotDraft<any>(scope);
    const expected = new Date(Date.now() + 5 * 86400000);
    const { appRouter } = await import("../routers");
    const admin = appRouter.createCaller({ user: (await getUserById(1))!, authSession: null, authFailureReason: null,
      req: { headers: {}, socket: {}, protocol: "https", get: () => undefined }, res: { clearCookie: () => undefined } } as any);
    await admin.users.updateTrafficSettings({ userId: 2, expiresAt: expected.toISOString() });
    await callback(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await getUserById(2))!.expiresAt!.getTime(), Math.floor(expected.getTime() / 1000) * 1000, "a changed expiry must invalidate the old renewal preview");
    assert.equal((await store.readBotAction(scope, draft.confirmationKey))!.status, "rejected");
    await message("取消");
    await admin.users.updateTrafficSettings({ userId: 2, expiresAt: new Date(Date.now() - 86400000).toISOString() });
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await message("1个月");
    const exact = await store.readBotDraft<any>(scope);
    const confirmedDate = replies.at(-1).body.text.match(/续费后到期：<b>([^<]+)<\/b>/)[1];
    mock.timers.tick(60000);
    await callback(`fx:op:confirm:${exact.confirmationKey}`);
    mock.timers.reset();
    assert.equal((await getUserById(2))!.expiresAt!.toLocaleString("zh-CN"), confirmedDate, "renewal must use the expiry shown on the confirmation card");
  } else if (phase === "manage_revoked") {
    const customerFrom = { id: customerId, language_code: "zh" };
    const customerScope = { ...scope, actorUserId: 2 };
    const customerMessage = (text: string) => dispatch({ update_id: 0, message: { ...msg, from: customerFrom, text } });
    const customerClick = (data: string) => dispatch({ update_id: 0, callback_query: { id: "revoked-click", from: customerFrom, message: msg, data } });
    await db.setUserForwardGroupPermissions(2, [100]);
    await setSettings({ telegramAiUserManageEnabled: "true" });
    await customerMessage("添加转发规则到203.0.113.92:443");
    let draft = await store.readBotDraft<any>(customerScope);
    for (let i = 0; i < 3; i++) {
      await customerClick(`fx:op:choose:${draft.selection.key}:0`);
      draft = await store.readBotDraft<any>(customerScope);
    }
    assert.ok(draft.confirmationKey);
    const before = (await runtime.queryRaw<any>('SELECT COUNT(*) AS count FROM forward_rules WHERE "userId"=2'))[0].count;
    await setSettings({ telegramAiUserManageEnabled: "false" });
    await customerClick(`fx:op:confirm:${draft.confirmationKey}`);
    assert.equal((await runtime.queryRaw<any>('SELECT COUNT(*) AS count FROM forward_rules WHERE "userId"=2'))[0].count, before, "disabling user management must immediately reject a previously valid approval");
    assert.equal((await store.readBotAction(customerScope, draft.confirmationKey))!.status, "rejected");
    await customerMessage("取消");
    await setSettings({ telegramAiUserManageEnabled: "true" });
  } else throw new Error(`Unknown phase ${phase}`);
  assert.ok(!JSON.stringify(requests).includes("never-send-password"));
  assert.ok(!JSON.stringify(requests).includes("private-password"));
} finally { stopTelegramBot(); pollWake?.(); await new Promise<void>(resolve => setImmediate(resolve)); await runtime.closeDatabase(); }
