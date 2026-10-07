import { withKeyedTaskLock } from "./keyedTaskLock";

type PendingQuota = {
  rules: number;
  ports: number;
  portHolders: Map<number, number>;
};

export type RuleQuotaReservation = {
  release: () => Promise<void>;
};

const pendingByUser = new Map<number, PendingQuota>();

export async function reserveRuleCreateQuota(input: {
  userId: number;
  maxRules: number;
  maxPorts: number;
  sourcePort?: number;
  hasSourcePort?: () => Promise<boolean>;
  getRuleCount: () => Promise<number>;
  getPortCount: () => Promise<number>;
}): Promise<RuleQuotaReservation> {
  const userId = Number(input.userId);
  const maxRules = Math.max(0, Number(input.maxRules) || 0);
  const maxPorts = Math.max(0, Number(input.maxPorts) || 0);
  if (maxRules === 0 && maxPorts === 0) return { release: async () => undefined };

  return withKeyedTaskLock(`rule-create-quota:${userId}`, async () => {
    const pending = pendingByUser.get(userId) || { rules: 0, ports: 0, portHolders: new Map<number, number>() };
    const [ruleCount, portCount] = await Promise.all([
      maxRules > 0 ? input.getRuleCount() : Promise.resolve(0),
      maxPorts > 0 ? input.getPortCount() : Promise.resolve(0),
    ]);
    const portKey = Number(input.sourcePort || 0);
    const existingPort = input.hasSourcePort ? await input.hasSourcePort() : false;
    // 同一入口端口上的新域名只占规则额度。并发复用尚未写入的端口时，
    // 共用一个预留名额，直到最后一个持有人结束，避免提早释放保护。
    const holdPort = maxPorts > 0 && !existingPort;
    const additionalPorts = holdPort && (!portKey || !pending.portHolders.has(portKey)) ? 1 : 0;
    if (maxRules > 0 && Number(ruleCount) + pending.rules >= maxRules) {
      throw new Error(`您已达到最大规则数量限制（${maxRules} 条）`);
    }
    if (maxPorts > 0 && Number(portCount) + pending.ports + additionalPorts > maxPorts) {
      throw new Error(`您已达到最大端口数量限制（${maxPorts} 个）`);
    }

    if (holdPort && portKey) pending.portHolders.set(portKey, (pending.portHolders.get(portKey) || 0) + 1);
    pendingByUser.set(userId, {
      rules: pending.rules + (maxRules > 0 ? 1 : 0),
      ports: pending.ports + additionalPorts,
      portHolders: pending.portHolders,
    });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await withKeyedTaskLock(`rule-create-quota:${userId}`, async () => {
          const current = pendingByUser.get(userId);
          if (!current) return;
          let releasedPorts = holdPort && !portKey ? 1 : 0;
          if (holdPort && portKey) {
            const holders = (current.portHolders.get(portKey) || 1) - 1;
            if (holders > 0) current.portHolders.set(portKey, holders);
            else { current.portHolders.delete(portKey); releasedPorts = 1; }
          }
          const next = {
            rules: Math.max(0, current.rules - (maxRules > 0 ? 1 : 0)),
            ports: Math.max(0, current.ports - releasedPorts),
            portHolders: current.portHolders,
          };
          if (next.rules === 0 && next.ports === 0) pendingByUser.delete(userId);
          else pendingByUser.set(userId, next);
        });
      },
    };
  });
}

export function clearRuleQuotaReservationsForTest() {
  pendingByUser.clear();
}
