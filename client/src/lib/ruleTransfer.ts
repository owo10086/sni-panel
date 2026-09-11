import {
  FORWARD_TYPES,
  type ForwardRuleProtocol,
  type ForwardType,
} from "@shared/forwardTypes";
import { isValidSniValue, normalizeSniValue } from "@shared/sni";
import { z } from "zod";

export const RULE_TRANSFER_FILE_KIND = "forwardx.forward-rules";
export const RULE_TRANSFER_FILE_VERSION = 1;
export const RULE_TRANSFER_MAX_IMPORT_COUNT = 500;
export const RULE_TRANSFER_MAX_FILE_SIZE = 5 * 1024 * 1024;
export const SNI_BULK_IMPORT_LINE_FORMAT = "规则名#SNI域名#目标地址#目标端口";

export type ProxyProtocolVersion = 1 | 2;
export type FailoverStrategy = "fallback" | "round_robin" | "random" | "ip_hash";

export type RuleTransferFileRule = {
  name: string;
  forwardType: ForwardType;
  protocol: ForwardRuleProtocol;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
  isEnabled: boolean;
  telegramErrorNotifyEnabled?: boolean;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: boolean;
  proxyProtocolExitSend: boolean;
  proxyProtocolVersion: ProxyProtocolVersion;
  tcpFastOpen: boolean;
  zeroCopy: boolean;
  udpOverTcp: boolean;
  udpOverTcpPort: number;
  failoverEnabled: boolean;
  failoverStrategy: FailoverStrategy;
  failoverTargets: Array<{ targetIp: string; targetPort: number }>;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
};

export type RuleBulkImportRule = RuleTransferFileRule & {
  sni?: string;
  sourceLine?: string;
  sourceLineNumber?: number;
};

export type SniBulkImportRule = RuleBulkImportRule & {
  sni: string;
  sourceLine: string;
  sourceLineNumber: number;
};

export type SniBulkImportParseResult =
  | { ok: true; message: string; rules: SniBulkImportRule[] }
  | { ok: false; message: string; rules: [] };

type SniBulkImportLineParseResult =
  | { ok: true; rule: SniBulkImportRule }
  | { ok: false; message: string };

export type RuleTransferFile = {
  kind: typeof RULE_TRANSFER_FILE_KIND;
  version: typeof RULE_TRANSFER_FILE_VERSION;
  exportedAt?: string;
  scope?: {
    type?: string;
    id?: number;
    name?: string;
  };
  rules: RuleTransferFileRule[];
};

export type RuleTransferParseResult =
  | { ok: true; file: RuleTransferFile }
  | { ok: false; error: string };

const targetHostSchema = z.string().trim().min(1).max(253).refine(
  (value) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(value),
  "地址格式不正确",
);
const ipv6AddressSchema = z.string().ip({ version: "v6" });

const failoverTargetSchema = z.object({
  targetIp: targetHostSchema,
  targetPort: z.number().int().min(1).max(65535),
});

const ruleTransferRuleSchema = z.object({
  name: z.string().trim().min(1).max(128).optional().default("导入规则"),
  forwardType: z.enum(FORWARD_TYPES).optional().default("iptables"),
  protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
  sourcePort: z.number().int().min(0).max(65535),
  targetIp: targetHostSchema,
  targetPort: z.number().int().min(1).max(65535),
  isEnabled: z.boolean().optional().default(true),
  telegramErrorNotifyEnabled: z.boolean().optional().default(false),
  proxyProtocolReceive: z.boolean().optional().default(false),
  proxyProtocolSend: z.boolean().optional().default(false),
  proxyProtocolExitReceive: z.boolean().optional().default(false),
  proxyProtocolExitSend: z.boolean().optional().default(false),
  proxyProtocolVersion: z.union([z.literal(1), z.literal(2)]).optional().default(1),
  tcpFastOpen: z.boolean().optional().default(false),
  zeroCopy: z.boolean().optional().default(false),
  udpOverTcp: z.boolean().optional().default(false),
  udpOverTcpPort: z.number().int().min(0).max(65535).optional().default(0),
  failoverEnabled: z.boolean().optional().default(false),
  failoverStrategy: z.enum(["fallback", "round_robin", "random", "ip_hash"]).optional().default("fallback"),
  failoverTargets: z.array(failoverTargetSchema).max(10).optional().default([]),
  failoverSeconds: z.number().int().min(10).max(3600).optional().default(60),
  recoverSeconds: z.number().int().min(10).max(3600).optional().default(120),
  autoFailback: z.boolean().optional().default(true),
});

export function normalizeSniImportDomain(value: unknown) {
  return normalizeSniValue(value);
}

export function isSniBulkImportRule(rule: RuleBulkImportRule): rule is RuleBulkImportRule & { sni: string } {
  return !!normalizeSniImportDomain(rule.sni);
}

export function formatSniBulkImportRuleLine(rule: RuleBulkImportRule) {
  if (rule.sourceLine) return rule.sourceLine;
  const targetIp = rule.targetIp.includes(":") ? `[${rule.targetIp}]` : rule.targetIp;
  return `${rule.name}#${normalizeSniImportDomain(rule.sni)}#${targetIp}#${rule.targetPort}`;
}

function parseSniBulkImportLine(line: string, lineNumber: number, sourcePort: number): SniBulkImportLineParseResult {
  const sourceLine = line.trim();
  const parts = sourceLine.split("#");
  if (parts.length !== 4) {
    return { ok: false, message: `第 ${lineNumber} 行：请按 ${SNI_BULK_IMPORT_LINE_FORMAT} 格式填写` };
  }
  const [nameRaw, sniRaw, targetIpRaw, targetPortRaw] = parts.map((part) => part.trim());
  if (!nameRaw) return { ok: false, message: `第 ${lineNumber} 行：规则名不能为空` };
  if (nameRaw.length > 128) return { ok: false, message: `第 ${lineNumber} 行：规则名不能超过 128 个字符` };
  const sni = normalizeSniImportDomain(sniRaw);
  if (!sni) return { ok: false, message: `第 ${lineNumber} 行：SNI 域名不能为空` };
  if (!isValidSniValue(sni)) return { ok: false, message: `第 ${lineNumber} 行：SNI 域名格式不正确` };
  const targetIsBracketed = targetIpRaw.startsWith("[") && targetIpRaw.endsWith("]");
  const targetIp = targetIsBracketed ? targetIpRaw.slice(1, -1).trim() : targetIpRaw;
  if (targetIp.includes(":") && !targetIsBracketed) {
    return { ok: false, message: `第 ${lineNumber} 行：IPv6 地址请使用 [地址] 格式` };
  }
  if (targetIsBracketed && !targetIp.includes(":")) {
    return { ok: false, message: `第 ${lineNumber} 行：目标地址格式不正确` };
  }
  if (targetIsBracketed && !ipv6AddressSchema.safeParse(targetIp).success) {
    return { ok: false, message: `第 ${lineNumber} 行：IPv6 地址格式不正确` };
  }
  const targetResult = targetHostSchema.safeParse(targetIp);
  if (!targetResult.success) {
    const message = targetIp ? "目标地址格式不正确" : "目标地址不能为空";
    return { ok: false, message: `第 ${lineNumber} 行：${message}` };
  }
  if (!/^\d+$/.test(targetPortRaw)) {
    return { ok: false, message: `第 ${lineNumber} 行：目标端口必须在 1-65535 之间` };
  }
  const targetPort = Number(targetPortRaw);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return { ok: false, message: `第 ${lineNumber} 行：目标端口必须在 1-65535 之间` };
  }
  return {
    ok: true,
    rule: {
      name: nameRaw,
      forwardType: "iptables",
      protocol: "tcp",
      sourcePort,
      sni,
      targetIp: targetResult.data,
      targetPort,
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
      sourceLine,
      sourceLineNumber: lineNumber,
    },
  };
}

export function parseSniBulkImportText(raw: unknown, sourcePort: number): SniBulkImportParseResult {
  if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
    return { ok: false, message: "入口端口必须在 1-65535 之间", rules: [] };
  }
  const filledLines = String(raw || "")
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((item) => item.line.trim());
  if (filledLines.length === 0) {
    return { ok: false, message: `请输入 SNI 分流规则，每行格式为 ${SNI_BULK_IMPORT_LINE_FORMAT}`, rules: [] };
  }
  if (filledLines.length > RULE_TRANSFER_MAX_IMPORT_COUNT) {
    return { ok: false, message: `单次最多导入 ${RULE_TRANSFER_MAX_IMPORT_COUNT} 条规则`, rules: [] };
  }

  const rules: SniBulkImportRule[] = [];
  const seen = new Map<string, number>();
  for (const item of filledLines) {
    const parsed = parseSniBulkImportLine(item.line, item.lineNumber, sourcePort);
    if (!parsed.ok) return { ...parsed, rules: [] };
    const { rule } = parsed;
    const { sni } = rule;
    const previousLine = seen.get(sni);
    if (previousLine !== undefined) {
      return {
        ok: false,
        message: `第 ${item.lineNumber} 行：SNI 域名 ${sni} 与第 ${previousLine} 行重复`,
        rules: [],
      };
    }
    seen.set(sni, item.lineNumber);
    rules.push(rule);
  }
  return { ok: true, message: `已识别 ${rules.length} 条 SNI 分流规则`, rules };
}

function issueMessage(issue: z.ZodIssue) {
  const field = issue.path.length > 0 ? `字段 ${issue.path.join(".")}` : "内容";
  return `${field}${issue.message ? `：${issue.message}` : "格式不正确"}`;
}

export function parseRuleTransferFile(raw: unknown): RuleTransferParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "文件内容不是有效的规则对象" };
  }
  const source = raw as Record<string, unknown>;
  if (source.kind !== RULE_TRANSFER_FILE_KIND) {
    return { ok: false, error: "文件不是 ForwardX 转发规则导出文件" };
  }
  if (source.version !== RULE_TRANSFER_FILE_VERSION) {
    return { ok: false, error: `不支持该规则文件版本（当前支持 v${RULE_TRANSFER_FILE_VERSION}）` };
  }
  if (!Array.isArray(source.rules) || source.rules.length === 0) {
    return { ok: false, error: "文件中没有可导入的规则" };
  }
  if (source.rules.length > RULE_TRANSFER_MAX_IMPORT_COUNT) {
    return { ok: false, error: `单次最多导入 ${RULE_TRANSFER_MAX_IMPORT_COUNT} 条规则` };
  }

  const rules: RuleTransferFileRule[] = [];
  for (let index = 0; index < source.rules.length; index += 1) {
    const parsed = ruleTransferRuleSchema.safeParse(source.rules[index]);
    if (!parsed.success) {
      return { ok: false, error: `第 ${index + 1} 条规则${issueMessage(parsed.error.issues[0])}` };
    }
    rules.push(parsed.data);
  }

  const scopeSource = source.scope && typeof source.scope === "object" && !Array.isArray(source.scope)
    ? source.scope as Record<string, unknown>
    : null;
  return {
    ok: true,
    file: {
      kind: RULE_TRANSFER_FILE_KIND,
      version: RULE_TRANSFER_FILE_VERSION,
      exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : undefined,
      scope: scopeSource
        ? {
            type: typeof scopeSource.type === "string" ? scopeSource.type : undefined,
            id: typeof scopeSource.id === "number" ? scopeSource.id : undefined,
            name: typeof scopeSource.name === "string" ? scopeSource.name : undefined,
          }
        : undefined,
      rules,
    },
  };
}

export function findRuleTransferPortConflict(rules: readonly RuleTransferFileRule[]) {
  const seen = new Map<number, number>();
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.sourcePort === 0) continue;
    const previousIndex = seen.get(rule.sourcePort);
    if (previousIndex !== undefined) {
      return {
        port: rule.sourcePort,
        firstIndex: previousIndex,
        secondIndex: index,
      };
    }
    seen.set(rule.sourcePort, index);
  }
  return null;
}
