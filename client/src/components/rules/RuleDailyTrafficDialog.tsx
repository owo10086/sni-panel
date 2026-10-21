import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { formatRuleTraffic } from "@/lib/ruleTrafficDisplay";

/** The server has already normalized hop accounting, but retains one row per host. */
export function totalRuleDailyTraffic(rows:ReadonlyArray<{ruleId:number;bytesIn:number;bytesOut:number}> | undefined,ruleId:number) {
  if (!rows) return undefined;
  return rows.filter(row => Number(row.ruleId) === ruleId).reduce((total,row) => ({
    bytesIn:total.bytesIn + (Number(row.bytesIn) || 0),
    bytesOut:total.bytesOut + (Number(row.bytesOut) || 0),
  }),{bytesIn:0,bytesOut:0});
}

export function RuleDailyTrafficContent({loading,error,hasRecords,totals}: {
  loading:boolean;error:boolean;hasRecords:boolean;totals?:{bytesIn:number;bytesOut:number};
}) {
  if (error) return <p role="alert" className="text-sm text-destructive">{t("流量读取失败，请重试")}</p>;
  if (loading) return <p role="status" className="text-sm text-muted-foreground">{t("加载中...")}</p>;
  if (!hasRecords || !totals) return <p className="text-sm text-muted-foreground">{t("暂无流量记录")}</p>;
  return <dl className="grid grid-cols-[1fr_auto] gap-3 text-sm">
    <dt className="text-muted-foreground">{t("入向")}</dt><dd className="text-right tabular-nums">{formatRuleTraffic(totals.bytesIn)}</dd>
    <dt className="text-muted-foreground">{t("出向")}</dt><dd className="text-right tabular-nums">{formatRuleTraffic(totals.bytesOut)}</dd>
  </dl>;
}

export function RuleDailyTrafficDialog({rule,onClose,onHistory}: {rule:{id:number;name:string};onClose:()=>void;onHistory:()=>void}) {
  const options = {refetchInterval:pollingInterval("slow",true),refetchOnMount:"always" as const,refetchOnWindowFocus:false};
  const summary = trpc.rules.trafficSummary.useQuery({ruleIds:[rule.id],range:"24h",hours:24},options);
  // Summary fills absent rules with zeros. Use the latest real sample only
  // to establish presence; the summary retains topology-aware accounting.
  const samples = trpc.rules.traffic.useQuery({ruleId:rule.id,limit:1},options);
  const latestAt = samples.data?.[0]?.recordedAt;
  const hasRecords = !!latestAt && new Date(latestAt).getTime() >= Date.now() - 24 * 3600_000;
  const totals = totalRuleDailyTraffic(summary.data,rule.id);
  return <Dialog open onOpenChange={open => !open && onClose()}>
    <DialogContent className="sm:max-w-md"><DialogHeader>
      <DialogTitle>{t("24小时流量")}</DialogTitle><DialogDescription>{rule.name} · {t("最近连续 24 小时")}</DialogDescription>
    </DialogHeader>
      <RuleDailyTrafficContent loading={summary.isLoading || samples.isLoading} error={summary.isError || samples.isError} hasRecords={hasRecords} totals={totals} />
      {(summary.isError || samples.isError) && <Button variant="outline" onClick={() => { void summary.refetch(); void samples.refetch(); }}>{t("重试")}</Button>}
      <Button variant="outline" onClick={onHistory}>{t("查看延迟历史")}</Button>
    </DialogContent>
  </Dialog>;
}
