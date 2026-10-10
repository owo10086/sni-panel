import assert from "node:assert/strict";
import test from "node:test";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "../i18n";
import {
  RULE_TRANSFER_FILE_KIND,
  RULE_TRANSFER_FILE_VERSION,
  findRuleTransferPortConflict,
  parseRuleTransferFile,
  parseSniBulkImportText,
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
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});
