import { useCallback, useSyncExternalStore } from "react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { ruleLatencyTimestamp, type RuleLatencyStore } from "@/lib/ruleLatencyStore";
import type { RuleProbeSummary } from "@/lib/ruleProbeCache";
import { LatencyRating } from "@/components/LatencyRating";
import { getLinkTestTotalLatency, parseLinkTestMessage } from "@/components/LinkTestLatencySummary";
import { cn } from "@/lib/utils";

export function RuleLatencyButton({ruleId,configurationKey,summary,disabled,store}: {
  ruleId:number;configurationKey:string;summary?:RuleProbeSummary;disabled:boolean;
  store:RuleLatencyStore;
}) {
  const utils = trpc.useUtils();
  const mutation = trpc.rules.startSelfTest.useMutation();
  const subscribe = useCallback((listener:()=>void) => store.subscribe(ruleId,listener),[store,ruleId]);
  const getSnapshot = useCallback(() => store.snapshot(ruleId,configurationKey),[store,ruleId,configurationKey]);
  const current = useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const baselineAt = store.acceptsSummary(ruleId,configurationKey,summary) ? ruleLatencyTimestamp(summary?.latestLatencyAt) : 0;
  const resultAt = ruleLatencyTimestamp(current.result?.updatedAt) || current.completedAt || 0;
  const baselineIsNewer = current.phase !== "testing" && baselineAt > resultAt;
  const useManual = current.phase !== "idle" && !baselineIsNewer;
  const testing = current.phase === "testing";
  let content;
  if (useManual) {
    const result = current.result;
    const total = result && getLinkTestTotalLatency({parsed:parseLinkTestMessage(result.message),fallbackLatencyMs:result.latencyMs,isSuccess:current.phase === "success"});
    content = testing ? t("测试中…") : current.phase === "timeout" ? t("超时") : current.phase === "failed" ? t("失败")
      : total != null ? <LatencyRating latencyMs={total} className="whitespace-nowrap" /> : t("无数据");
  } else {
    content = baselineAt > 0
      ? summary?.latestLatencyIsTimeout ? <LatencyRating isTimeout timeoutText={t("超时")} />
        : typeof summary?.latestLatencyMs === "number" ? <LatencyRating latencyMs={summary.latestLatencyMs} className="whitespace-nowrap" /> : t("未测")
      : t("未测");
  }
  return <button type="button" disabled={disabled || testing} aria-busy={testing} className={cn("inline-flex min-h-8 items-center whitespace-nowrap text-xs underline decoration-dotted underline-offset-4 disabled:cursor-default disabled:no-underline",useManual && ["failed","timeout"].includes(current.phase) && "text-destructive")}
    title={disabled ? t("当前规则不可测试") : testing ? t("测试中…") : useManual && current.phase === "failed" ? `${current.message || parseLinkTestMessage(current.result?.message).message || t("失败")} · ${t("点击重试")}` : t("点击立即测试，可再次测试")}
    onClick={() => {
      if (disabled) return;
      void store.start(ruleId,configurationKey,{start:() => mutation.mutateAsync({ruleId}),latest:() => utils.rules.latestTest.fetch({ruleId,includeActive:true},{staleTime:0})}).then(() => {
        void utils.rules.trafficSummary.invalidate();
        void utils.rules.tcpingSeries.invalidate({ruleId,hours:24});
      });
    }}>{content}</button>;
}
