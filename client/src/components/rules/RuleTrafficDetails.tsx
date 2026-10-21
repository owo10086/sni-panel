import { t } from "@/i18n";
import { formatRuleTraffic } from "@/lib/ruleTrafficDisplay";
import { RuleUsageSummary } from "./RuleUsageSummary";

export function RuleTrafficDetailsContent({rule,totals}: {rule:any;totals?:{bytesIn:number;bytesOut:number}}) {
  return <div className="space-y-4 text-sm">
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
      <dt className="text-muted-foreground">{t("累计总流量")}</dt><dd className="text-right font-medium tabular-nums">{totals ? formatRuleTraffic(Number(totals.bytesIn) + Number(totals.bytesOut)) : "—"}</dd>
      <dt className="text-muted-foreground">{t("入向")}</dt><dd className="text-right tabular-nums">{totals ? formatRuleTraffic(totals.bytesIn) : "—"}</dd>
      <dt className="text-muted-foreground">{t("出向")}</dt><dd className="text-right tabular-nums">{totals ? formatRuleTraffic(totals.bytesOut) : "—"}</dd>
    </dl>
    <RuleUsageSummary rule={rule} totals={totals} formatBytes={formatRuleTraffic} />
    <p className="text-xs leading-5 text-muted-foreground">{t("累计总流量计算入向与出向；额度已用按本规则设置计算。")}</p>
  </div>;
}
