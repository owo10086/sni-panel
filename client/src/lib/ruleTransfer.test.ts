import assert from "node:assert/strict";
import test from "node:test";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "../i18n";
import {
  RULE_TRANSFER_FILE_KIND,
  RULE_TRANSFER_FILE_VERSION,
  findRuleTransferPortConflict,
  parseRuleTransferFile,
  parseSniBulkImportText,
  parseManualBulkImportText,
  formatManualBulkImportRuleLine,
  parseRuleImportPorts,
  assignRuleImportPorts,
  parseManualRuleImportLine,
  serializeRuleTransferText,
  parseRuleTransferText,
  type RuleTransferFileRule,
} from "./ruleTransfer";

function validRule(overrides: Partial<RuleTransferFileRule> = {}) {
  return {
    name: "test",
    forwardType: "gost",
    protocol: "tcp",
    sourcePort: 10001,
    rateLimitMbps: 0,
    maxConnections: 0,
    targetIp: "example.com",
    targetPort: 443,
    isEnabled: true,
    telegramErrorNotifyEnabled: false,
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
    tcpFastOpen: false,
    zeroCopy: false,
    udpOverTcp: false,
    udpOverTcpPort: 0,
    failoverEnabled: false,
    failoverStrategy: "fallback",
    failoverTargets: [],
    failoverSeconds: 60,
    recoverSeconds: 120,
    autoFailback: true,
    ...overrides,
  } satisfies RuleTransferFileRule;
}

function transferFile(rule: unknown) {
  return {
    kind: RULE_TRANSFER_FILE_KIND,
    version: RULE_TRANSFER_FILE_VERSION,
    rules: [rule],
  };
}

test("rule transfer parser preserves a valid exported rule", () => {
  const rule = validRule({ protocol: "both", failoverEnabled: true, isEnabled: false });
  const parsed = parseRuleTransferFile(transferFile(rule));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.file.rules : [], [rule]);
});

test("rule transfer parser rejects coercible booleans and unknown enums", () => {
  const stringBoolean = parseRuleTransferFile(transferFile({ ...validRule(), tcpFastOpen: "false" }));
  assert.equal(stringBoolean.ok, false);
  assert.match(stringBoolean.ok ? "" : stringBoolean.error, /tcpFastOpen/);

  const unknownProtocol = parseRuleTransferFile(transferFile({ ...validRule(), protocol: "quic" }));
  assert.equal(unknownProtocol.ok, false);
  assert.match(unknownProtocol.ok ? "" : unknownProtocol.error, /protocol/);

  const unknownForwardType = parseRuleTransferFile(transferFile({ ...validRule(), forwardType: "unknown" }));
  assert.equal(unknownForwardType.ok, false);
  assert.match(unknownForwardType.ok ? "" : unknownForwardType.error, /forwardType/);
});

test("rule transfer parser enforces server-side timing and target constraints", () => {
  const shortFailover = parseRuleTransferFile(transferFile({ ...validRule(), failoverSeconds: 1 }));
  assert.equal(shortFailover.ok, false);
  assert.match(shortFailover.ok ? "" : shortFailover.error, /failoverSeconds/);

  const badTarget = parseRuleTransferFile(transferFile({ ...validRule(), targetIp: "bad host" }));
  assert.equal(badTarget.ok, false);
  assert.match(badTarget.ok ? "" : badTarget.error, /targetIp/);
});

test("rule transfer parser enforces the import count limit", () => {
  const parsed = parseRuleTransferFile({
    kind: RULE_TRANSFER_FILE_KIND,
    version: RULE_TRANSFER_FILE_VERSION,
    rules: Array.from({ length: 501 }, () => validRule()),
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /500/);
});

test("rule transfer conflict detection treats a listener port as one runtime identity", () => {
  assert.deepEqual(
    findRuleTransferPortConflict([validRule(), validRule({ protocol: "both" })]),
    { port: 10001, firstIndex: 0, secondIndex: 1 },
  );
  assert.deepEqual(
    findRuleTransferPortConflict([validRule({ protocol: "tcp" }), validRule({ protocol: "udp" })]),
    { port: 10001, firstIndex: 0, secondIndex: 1 },
  );
  assert.equal(
    findRuleTransferPortConflict([validRule({ sourcePort: 0 }), validRule({ sourcePort: 0 })]),
    null,
  );
});

test("导入提示随语言切换，保存的默认名称和业务字段保持一致", async () => {
  const previous = getLanguagePreference();
  const rule = validRule();
  const { name: _name, ...withoutName } = rule;
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const format = parseSniBulkImportText("", 18443);
    assert.equal(format.ok, false);
    assert.equal(format.message, "Enter one SNI rule per line using the format Rule name#SNI domain#Target address#Target port");
    const invalid = parseRuleTransferFile(transferFile({ ...rule, targetIp: "bad host" }));
    assert.equal(invalid.ok, false);
    assert.match(invalid.ok ? "" : invalid.error, /Invalid address format/);
    const english = parseRuleTransferFile(transferFile(withoutName));
    assert.equal(english.ok, true);
    if (english.ok) assert.equal(english.file.rules[0].name, "导入规则");
    setLanguagePreference("zh-CN");
    await initializeLanguage();
    assert.deepEqual(parseRuleTransferFile(transferFile(withoutName)), english);
    assert.equal(parseSniBulkImportText("", 18443).message, "请输入 SNI 分流规则，每行格式为 规则名#SNI域名#目标地址#目标端口");
    const manualInput = "用户名称 unchanged <&>#10443#example.com#443";
    const chineseManual = parseManualBulkImportText(manualInput, { forwardType: "iptables", protocol: "both" });
    setLanguagePreference("en");
    await initializeLanguage();
    assert.deepEqual(parseManualBulkImportText(manualInput, { forwardType: "iptables", protocol: "both" }).rules, chineseManual.rules);
    assert.equal(parseManualBulkImportText("", { forwardType: "iptables", protocol: "both" }).message, "Enter one rule per line using address:port or Rule name#Source port#Target address#Target port");
    assert.equal(parseManualBulkImportText("\nname#0#example.com#443", { forwardType: "iptables", protocol: "both" }).message, "Line 2: Source port must be a decimal integer from 1-65535");
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});


test("SNI transfer preserves quota and expiry alongside its route and member limits", () => {
  const parsed = parseRuleTransferFile({
    ...transferFile(validRule({ sni: "api.example.com", sourcePort: 18443, rateLimitMbps: 15, maxConnections: 8 })),
    scope: { type: "group", id: 10, name: "primary and backup" },
    rules: [{ ...validRule({ sni: "api.example.com", sourcePort: 18443, rateLimitMbps: 15, maxConnections: 8 }), trafficLimit: 123456, trafficMode: "both", expiresAt: "2030-10-10T00:00:00.000Z" }],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.file.scope?.type, "group");
  assert.equal(parsed.file.scope?.id, 10);
  assert.equal(parsed.file.rules[0].trafficLimit, 123456);
  assert.equal(parsed.file.rules[0].trafficMode, "both");
  assert.equal(parsed.file.rules[0].expiresAt, "2030-10-10T00:00:00.000Z");
});

const manualDefaults = { forwardType: "realm", protocol: "both" } satisfies Pick<RuleTransferFileRule, "forwardType" | "protocol">;

test("manual import preserves mixed formats, original lines, defaults and IPv6", () => {
  const input = "  官网 unchanged <&>#10443# example.com #443  \r\n\r\n内网#18080#10.0.0.8#8080\r\nIPv6#18443#[2001:db8::1]#8443\r\nexample.net:443";
  const parsed = parseManualBulkImportText(input, manualDefaults);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.rules.map(rule => [rule.name, rule.sourcePort, rule.targetIp, rule.targetPort, rule.sourceLineNumber]), [
    ["官网 unchanged <&>", 10443, "example.com", 443, 1],
    ["内网", 18080, "10.0.0.8", 8080, 3],
    ["IPv6", 18443, "2001:db8::1", 8443, 4],
    ["example.net:443", 0, "example.net", 443, 5],
  ]);
  for (const rule of parsed.rules) {
    assert.equal(rule.forwardType, "realm");
    assert.equal(rule.protocol, "both");
    assert.equal(rule.isEnabled, true);
    assert.equal(rule.sni, undefined);
  }
  assert.equal(parsed.rules[0].sourceLine, "官网 unchanged <&>#10443# example.com #443");
  assert.equal(formatManualBulkImportRuleLine(parsed.rules[0]), parsed.rules[0].sourceLine);
  const retry = parsed.rules.map(formatManualBulkImportRuleLine).join("\n");
  assert.deepEqual(parseManualBulkImportText(retry, manualDefaults).rules.map(({ sourceLineNumber, ...rule }) => rule), parsed.rules.map(({ sourceLineNumber, ...rule }) => rule));
});

test("manual legacy format keeps existing numeric and unbracketed IPv6 behavior", () => {
  const lines = ["example.com:1e3", "example.com:0x50", "2001:db8::2:8443", "[2001:db8::3]:8443", "10.0.0.8:8080"];
  const parsed = parseManualBulkImportText(lines.join("\n"), manualDefaults);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.rules.map(rule => [rule.name, rule.sourcePort, rule.targetIp, rule.targetPort]), [
    ["example.com:1000", 0, "example.com", 1000],
    ["example.com:80", 0, "example.com", 80],
    ["[2001:db8::2]:8443", 0, "2001:db8::2", 8443],
    ["[2001:db8::3]:8443", 0, "2001:db8::3", 8443],
    ["10.0.0.8:8080", 0, "10.0.0.8", 8080],
  ]);
  assert.deepEqual(parsed.rules.map(formatManualBulkImportRuleLine), lines);
});

test("manual four-field import enforces decimal port limits and actual input line numbers", () => {
  for (const port of ["1", "65535"]) {
    assert.equal(parseManualBulkImportText(`name#${port}#example.com#${port}`, manualDefaults).ok, true);
  }
  for (const port of ["", "0", "65536", "-1", "1.5", "1e3", "0x50", "+80"]) {
    for (const line of [`name#${port}#example.com#443`, `name#10443#example.com#${port}`]) {
      const parsed = parseManualBulkImportText(`valid.example:443\n\n${line}`, manualDefaults);
      assert.equal(parsed.ok, false, line);
      assert.deepEqual(parsed.rules, []);
      assert.match(parsed.message, /第 3 行/);
      assert.match(parsed.message, /1-65535/);
    }
  }
});

test("manual four-field import rejects malformed fields without falling back to legacy", () => {
  for (const line of [
    "name#10443#example.com", "name#10443#example.com#443#extra", "#10443#example.com#443",
    `${"n".repeat(129)}#10443#example.com#443`, "name#10443##443", "name#10443#bad host#443",
    `name#10443#${"a".repeat(254)}#443`, "name#10443#2001:db8::1#443", "name#10443#[2001:xxxx::1]#443",
    "name#10443#[example.com]#443", "example.com#443:80",
  ]) {
    const parsed = parseManualBulkImportText(line, manualDefaults);
    assert.equal(parsed.ok, false, line);
    assert.deepEqual(parsed.rules, []);
    assert.match(parsed.message, /第 1 行/);
  }
  assert.equal(parseManualBulkImportText(`${"n".repeat(128)}#10443#example.com#443`, manualDefaults).ok, true);
});

test("manual import rejects empty input, bad legacy lines and more than 500 nonempty lines", () => {
  for (const input of ["", "\n \n", "example.com", "[2001:db8::1]443", "bad host:443", "example.com:0"]) {
    assert.equal(parseManualBulkImportText(input, manualDefaults).ok, false, input);
  }
  const line = "name#10443#example.com#443";
  assert.equal(parseManualBulkImportText(Array(500).fill(line).join("\n\n"), manualDefaults).ok, true);
  const tooMany = parseManualBulkImportText(Array(501).fill(line).join("\n"), manualDefaults);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /500/);
});

test("manual retry formatter rebuilds missing original lines including IPv6", () => {
  assert.equal(formatManualBulkImportRuleLine(validRule({ name: "IPv6", targetIp: "2001:db8::1", targetPort: 443, sourcePort: 10443 })), "IPv6#10443#[2001:db8::1]#443");
  assert.equal(formatManualBulkImportRuleLine(validRule({ targetIp: "2001:db8::1", targetPort: 443, sourcePort: 0 })), "[2001:db8::1]:443");
});

test("batch import ports expand ranges and mixed lists in the entered order", () => {
  for (const [input, expected] of [
    ["", []], ["  ", []], ["10000-10002", [10000, 10001, 10002]],
    ["10000,10001,10002", [10000, 10001, 10002]],
    ["10001-10005,10008", [10001, 10002, 10003, 10004, 10005, 10008]],
    ["20000, 10001 - 10003，65535", [20000, 10001, 10002, 10003, 65535]],
    ["1-1,2", [1, 2]],
  ] as const) {
    const result = parseRuleImportPorts(input);
    assert.equal(result.ok, true, input);
    assert.deepEqual(result.ok ? result.ports : [], expected);
  }
  const all = parseRuleImportPorts("1-65535");
  assert.equal(all.ok && all.ports.length, 65535);
});

test("batch import rejects malformed, out-of-range and overlapping ports", () => {
  for (const input of ["0", "65536", "999999999", "10005-10001", "-1", "1.5", "1e3", "10001,", ",10001", "10001,,10002", "abc", "10000:10020", "10000-", "10000,10000", "10000-10005,10003", "10000 10001", "1".repeat(8193)]) {
    assert.equal(parseRuleImportPorts(input).ok, false, input.slice(0, 100));
  }
});

test("batch import assigns ports by rule order, fills shortages with random and leaves originals untouched", () => {
  const rules = Array.from({ length: 8 }, (_, index) => validRule({ name: String(index), sourcePort: 30000 + index }));
  const parsed = parseRuleImportPorts("10001-10005,10008");
  assert.ok(parsed.ok);
  const assigned = assignRuleImportPorts(rules, parsed.ports);
  assert.deepEqual(assigned.map(rule => rule.sourcePort), [10001, 10002, 10003, 10004, 10005, 10008, 0, 0]);
  assert.deepEqual(rules.map(rule => rule.sourcePort), [30000, 30001, 30002, 30003, 30004, 30005, 30006, 30007]);
  assert.deepEqual(assignRuleImportPorts(rules, []), rules, "blank input preserves exported ports");
  assert.deepEqual(assignRuleImportPorts(rules.slice(0, 2), parsed.ports).map(rule => rule.sourcePort), [10001, 10002]);
  const failed = [assigned[1], assigned[6]];
  const regenerated = failed.map(rule => ({ ...rule, sourcePort: 0, protocol: "udp" as const }));
  const retry = assignRuleImportPorts(regenerated, failed.map(rule => rule.sourcePort));
  assert.deepEqual(retry.map(rule => rule.sourcePort), [10002, 0], "retry keeps failed assignments instead of reusing the first input ports");
  assert.ok(retry.every(rule => rule.protocol === "udp"), "newly selected protocol is not replaced by a stale retry snapshot");
});

test("manual import supports per-line listener ports and existing target-only lines", () => {
  for (const [line, sourcePort, targetIp, targetPort] of [
    ["10001:example.com:443", 10001, "example.com", 443],
    ["10002:10.0.0.8:8080", 10002, "10.0.0.8", 8080],
    ["10003:[2408::1]:8443", 10003, "2408::1", 8443],
    ["example.com:443", 0, "example.com", 443],
    ["[2001:db8::1]:53", 0, "2001:db8::1", 53],
    [" 10004 : example.com : 443 ", 10004, "example.com", 443],
    ["10005：example.com：443", 10005, "example.com", 443],
    ["65535:example.com:1", 65535, "example.com", 1],
  ] as const) assert.deepEqual(parseManualRuleImportLine(line), { sourcePort, targetIp, targetPort }, line);
  const integrated = parseManualBulkImportText("\n10005：example.com：443\n\n10006:[2001:db8::1]:80", manualDefaults);
  assert.ok(integrated.ok, integrated.message);
  assert.deepEqual(integrated.rules.map(rule => [rule.sourcePort, rule.sourceLineNumber]), [[10005, 2], [10006, 4]]);
});

test("manual import rejects invalid listener/target ports and ambiguous or malformed addresses", () => {
  for (const line of ["0:example.com:443", "65536:example.com:443", "1.5:example.com:443", "-1:example.com:443", "1e3:example.com:443", "10001:example.com:0", "10001:example.com:65536", "10001::443", "10001:example.com:", "10001:http://example.com:443", "10001:[::::]:443", "10001:[example.com]:443", "10001:2001:db8::1:443", "bad host:443", "example.com:1e3", ""]) {
    assert.ok("error" in parseManualRuleImportLine(line), line);
  }
});

test("inline listeners take priority and bulk ports only fill unassigned lines", () => {
  const lines = ["10001:example.com:443", "two.example:80", "10003:[2001:db8::1]:443", "four.example:80", "five.example:80"];
  const rules = lines.map(line => {
    const parsed = parseManualRuleImportLine(line);
    assert.ok(!("error" in parsed));
    return validRule(parsed);
  });
  const assigned = assignRuleImportPorts(rules, [11001, 11002], true);
  assert.deepEqual(assigned.map(rule => rule.sourcePort), [10001, 11001, 10003, 11002, 0]);
  assert.deepEqual(assignRuleImportPorts(rules, [], true).map(rule => rule.sourcePort), [10001, 0, 10003, 0, 0]);
  const conflict = findRuleTransferPortConflict(assignRuleImportPorts(rules, [10001], true));
  assert.deepEqual(conflict, { port: 10001, firstIndex: 0, secondIndex: 1 });
  const failed = [assigned[1], assigned[2], assigned[4]];
  const retry = assignRuleImportPorts(failed, failed.map(rule => rule.sourcePort));
  assert.deepEqual(retry.map(rule => rule.sourcePort), [11001, 10003, 0], "retry ports remain aligned even when the first rule succeeded");
});

test("TXT exports round-trip fixed/random listeners and IPv4/IPv6 targets", () => {
  const rules = [
    validRule({ sourcePort: 10001, targetIp: "example.com", targetPort: 443 }),
    validRule({ sourcePort: 10002, targetIp: "10.0.0.8", targetPort: 8080 }),
    validRule({ sourcePort: 10003, targetIp: "2001:db8::1", targetPort: 8443 }),
    validRule({ sourcePort: 0, targetIp: "2001:db8::2", targetPort: 53 }),
  ];
  const text = serializeRuleTransferText(rules);
  assert.equal(text, "10001:example.com:443\n10002:10.0.0.8:8080\n10003:[2001:db8::1]:8443\n[2001:db8::2]:53");
  const parsed = parseRuleTransferText("\uFEFF" + text.replace(/\n/g, "\r\n") + "\r\n");
  assert.ok(parsed.ok);
  const addresses = (rows: RuleTransferFileRule[]) => rows.map(({ sourcePort, targetIp, targetPort }) => ({ sourcePort, targetIp, targetPort }));
  assert.deepEqual(addresses(parsed.file.rules), addresses(rules));
  for (const line of text.split("\n")) assert.ok(!("error" in parseManualRuleImportLine(line)), "export can also be pasted into manual input");
  assert.equal(serializeRuleTransferText([]), "");
});

test("TXT imports enforce limits and report malformed lines without silently dropping them", () => {
  for (const text of ["", "\n", "10001:example.com:443\nbad line", Array(501).fill("example.com:443").join("\n"), "x".repeat(5 * 1024 * 1024 + 1)]) {
    assert.equal(parseRuleTransferText(text).ok, false);
  }
  const invalid = parseRuleTransferText("10001:example.com:443\n10002:example.com:65536");
  assert.match(invalid.ok ? "" : invalid.error, /2/);
  const longHost = "x".repeat(63) + "." + "y".repeat(63) + ".example.com";
  const long = parseRuleTransferText(serializeRuleTransferText([validRule({ targetIp: longHost })]));
  assert.ok(long.ok);
  assert.equal(long.file.rules[0].targetIp, longHost);
  assert.ok(long.file.rules[0].name.length <= 128);
});

test("TXT imports retain original nonblank source lines for failed-row feedback", () => {
  const result = parseRuleTransferText("\n10001:example.com:443\n\n10002:[2001:db8::1]:80\n");
  assert.ok(result.ok);
  assert.deepEqual(result.file.rules.map(rule => (rule as any).sourceLineNumber), [2, 4]);
  const bad = parseRuleTransferText("\n10001:example.com:443\n\nbad line");
  assert.match(bad.ok ? "" : bad.error, /4/);
});
