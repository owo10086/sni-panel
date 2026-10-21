import { t as translateText } from "@/i18n";

type EntryDomainConfiguration = {
  entryHost: { id: number; name: string };
  sourcePort: number;
  domainSetConsistent: boolean;
  missingDomains: string[];
  routes: { ruleId: number }[];
};

/** Project the complete existing check; never recompute it from visible rows. */
export function SniDomainWarnings({ entries, rules, isAdmin }: {
  entries?: EntryDomainConfiguration[];
  rules: { id: number; sourcePort: number }[];
  isAdmin: boolean;
}) {
  if (!isAdmin) return null;
  const portsByRule = new Map(rules.map(rule => [Number(rule.id), Number(rule.sourcePort)]));
  const warnings = entries?.filter(entry => !entry.domainSetConsistent
    && entry.missingDomains.length > 0
    && entry.routes.some(route => portsByRule.get(Number(route.ruleId)) === Number(entry.sourcePort))) || [];
  if (warnings.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 border-l-2 border-amber-500/60 pl-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
      <p className="font-medium">{translateText("域名配置不一致")}</p>
      {warnings.map(entry => (
        <p key={`${entry.entryHost.id}:${entry.sourcePort}`} className="break-words">
          {translateText("入口「{0}:{1}」的域名配置不完整，缺少：{2}", [entry.entryHost.name, entry.sourcePort, entry.missingDomains.join("、")])}
        </p>
      ))}
      <p className="text-muted-foreground">{translateText("以上为面板规则配置核对，实际生效状态请查看分流器信息。")}</p>
    </div>
  );
}
