import { setBoundedMapValue } from "./boundedCache";

const failures = new Map<number, { admin: string; user: string }>();

export function recordRulePortFailure(ruleId: number, message: string) {
  if (!Number.isSafeInteger(ruleId) || ruleId <= 0) return;
  const match = /^port (\d{1,5}) occupied(?: by ([^\r\n]{1,128}))?$/i.exec(message.trim());
  if (!match) {
    failures.delete(ruleId);
    return;
  }
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return;
  const user = `端口 ${port} 已被占用`;
  setBoundedMapValue(failures, ruleId, {
    admin: match[2] ? `${user}，占用进程：${match[2]}` : user,
    user,
  }, 10_000);
}

export function getRulePortFailure(ruleId: number, admin: boolean) {
  const value = failures.get(ruleId);
  return value ? admin ? value.admin : value.user : null;
}
