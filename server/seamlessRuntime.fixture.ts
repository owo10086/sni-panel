// Synthetic business data for the isolated Agent/FXP migration verification.
import { executeRaw, quoteDbIdentifier as q } from "./dbRuntime";
import { setSettings } from "./repositories/settingsRepository";
import { AGENT_VERSION } from "../shared/versions";

export async function seedSeamlessRuntimeFixture(url: string, entryIp: string, exitIp: string) {
  const insert = (table: string, row: Record<string, unknown>) => executeRaw(
    `INSERT INTO ${q(table)} (${Object.keys(row).map(q).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row));
  await insert("users", { id: 3, username: "migration-admin", password: "fixture", role: "admin",
    canAddRules: true, manualCanAddRules: true, balanceCents: 100000 });
  for (const [id, ip, token] of [[7, entryIp, "migration-test-agent-token"], [8, exitIp, "migration-test-exit-token"]] as const) {
    await insert("hosts", { id, userId: 3, name: `managed-${id}`, ip, ipv4: ip, agentToken: token, agentVersion: AGENT_VERSION,
      isOnline: true, lastHeartbeat: Math.floor(Date.now() / 1000), portRangeStart: 18000, portRangeEnd: 40000 });
  }
  await insert("tunnels", { id: 7, userId: 3, name: "managed-tcp", entryHostId: 7, exitHostId: 8,
    mode: "tcp", listenPort: 23000, secret: "migration-fixture-tunnel-secret", isEnabled: true, isRunning: true });
  for (const [id, name, targetPort, limits] of [
    [101, "metered.example.test", 30443, { trafficLimit: 20000000, quotaUsedIn: 1000, quotaUsedOut: 2000 }],
    [102, "healthy.example.test", 30843, {}],
    [103, "exhausted.example.test", 31443, { trafficLimit: 1, quotaUsedIn: 2, quotaUsedOut: 3, ruleLimitReason: "traffic_limit" }],
    [104, "expired.example.test", 31843, { expiresAt: Math.floor(Date.now() / 1000) - 86400, ruleLimitReason: "expired" }],
  ] as const) {
    await insert("forward_rules", { id, userId: 3, hostId: 7, name, sourcePort: 18443, sni: name, sniSplitterPort: 24000,
      tunnelId: 7, tunnelExitPort: 24001, targetIp: exitIp, targetPort, forwardType: "gost", protocol: "tcp",
      isEnabled: true, isRunning: id < 103, ...limits });
  }
  await insert("forward_rules", { id: 200, userId: 3, hostId: 8, name: "plain-gost", sourcePort: 21001,
    targetIp: "127.0.0.1", targetPort: 30001, forwardType: "gost", protocol: "tcp", isEnabled: true, isRunning: true });
  await insert("payment_orders", { id: 1, outTradeNo: "MIGRATION-PAYMENT", userId: 3, provider: "gmpay",
    paymentType: "gmpay", orderType: "balance", status: "pending", subject: "migration recharge", amountCents: 200, currency: "CNY" });
  await setSettings({ panelPublicUrl: url, notificationProvider: "telegram", telegramEnabled: "false", discordEnabled: "false",
    paymentConfig: JSON.stringify({ gmpay: { enabled: true, pid: "1000", secretKey: "migration-test-payment-secret" } }) });
}
