import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { RuleLatencyRunner, type RuleLatencySnapshot } from "@/lib/ruleLatencyRunner";
import type { RuleProbeSummary } from "@/lib/ruleProbeCache";
import { LatencyRating } from "@/components/LatencyRating";
import { getLinkTestTotalLatency, parseLinkTestMessage } from "@/components/LinkTestLatencySummary";
import { cn } from "@/lib/utils";

function timestamp(value:unknown) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  return value ? new Date(String(value)).getTime() || 0 : 0;
}

export function RuleLatencyButton({ruleId,configurationKey,summary,disabled,saved,onComplete}: {
  ruleId:number;configurationKey:string;summary?:RuleProbeSummary;disabled:boolean;
  saved?:RuleLatencySnapshot;onComplete:(snapshot:RuleLatencySnapshot)=>void;
}) {
  const utils = trpc.useUtils();
  const mutation = trpc.rules.startSelfTest.useMutation();
  const [snapshot,setSnapshot] = useState<RuleLatencySnapshot>(saved || {phase:"idle",result:null});
  const completed = useRef(onComplete);
  completed.current=onComplete;
  const latestConfiguration = useRef(configurationKey);
  latestConfiguration.current=configurationKey;
  const activeConfiguration = useRef(configurationKey);
  const runner = useRef<RuleLatencyRunner | null>(null);
  if (!runner.current) runner.current=new RuleLatencyRunner(next => {
    setSnapshot(next);
    if (!["idle","testing"].includes(next.phase) && activeConfiguration.current === latestConfiguration.current) completed.current(next);
  });
  const previous = useRef(configurationKey);
  const [baselineAfter,setBaselineAfter] = useState(0);
  useEffect(() => {
    if (previous.current === configurationKey) return;
    previous.current=configurationKey;
    runner.current?.reset();
    setBaselineAfter(Math.floor(Date.now()/1000)*1000);
  },[configurationKey]);
  useEffect(() => () => runner.current?.dispose(),[]);

  const current = previous.current === configurationKey ? snapshot : {phase:"idle",result:null} as RuleLatencySnapshot;
  const baselineAt = timestamp(summary?.latestLatencyAt);
  const resultAt = timestamp(current.result?.updatedAt) || current.completedAt || 0;
  const baselineIsNewer = current.phase !== "testing" && baselineAt > resultAt && baselineAt >= baselineAfter;
  const useManual = current.phase !== "idle" && !baselineIsNewer;
  const testing = current.phase === "testing";
  let content;
  if (useManual) {
    const result = current.result;
    const total = result && getLinkTestTotalLatency({parsed:parseLinkTestMessage(result.message),fallbackLatencyMs:result.latencyMs,isSuccess:current.phase === "success"});
    content = testing ? t("测试中…") : current.phase === "timeout" ? t("超时") : current.phase === "failed" ? t("失败")
      : total != null ? <LatencyRating latencyMs={total} className="whitespace-nowrap" /> : t("无数据");
  } else {
    content = baselineAt >= baselineAfter && baselineAt > 0
      ? summary?.latestLatencyIsTimeout ? <LatencyRating isTimeout timeoutText={t("超时")} />
        : typeof summary?.latestLatencyMs === "number" ? <LatencyRating latencyMs={summary.latestLatencyMs} className="whitespace-nowrap" /> : t("未测")
      : t("未测");
  }
  return <button type="button" disabled={disabled || testing} aria-busy={testing} className={cn("inline-flex min-h-8 items-center whitespace-nowrap text-xs underline decoration-dotted underline-offset-4 disabled:cursor-default disabled:no-underline",useManual && ["failed","timeout"].includes(current.phase) && "text-destructive")}
    title={disabled ? t("当前规则不可测试") : testing ? t("测试中…") : useManual && current.phase === "failed" ? `${current.message || parseLinkTestMessage(current.result?.message).message || t("失败")} · ${t("点击重试")}` : t("点击立即测试，可再次测试")}
    onClick={() => {
      if (disabled) return;
      activeConfiguration.current=configurationKey;
      void runner.current?.start({start:() => mutation.mutateAsync({ruleId}),latest:() => utils.rules.latestTest.fetch({ruleId,includeActive:true},{staleTime:0})}).then(() => {
        void utils.rules.trafficSummary.invalidate();
        void utils.rules.tcpingSeries.invalidate({ruleId,hours:24});
      });
    }}>{content}</button>;
}
