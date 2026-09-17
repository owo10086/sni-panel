import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { SNI_SPLITTER_MIN_AGENT_VERSION } from "@shared/sni";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { Link } from "wouter";

export function SniEntryVersionPreflight({ enabled = true }: { enabled?: boolean }) {
  const overview = trpc.rules.sniEntryPortOverview.useQuery(undefined, {
    enabled,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!enabled) return null;
  if (overview.isLoading) {
    return (
      <div className="flex items-center gap-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
        <Loader2 className="forwardx-icon-spin h-4 w-4 shrink-0" />
        <span>正在检查 SNI 入口 Agent 版本</span>
      </div>
    );
  }
  if (overview.isError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>SNI 入口版本检查失败</AlertTitle>
        <AlertDescription className="break-words text-xs">{overview.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!overview.data || overview.data.entries.length === 0) return null;

  const minimumVersion = overview.data.minimumAgentVersion || SNI_SPLITTER_MIN_AGENT_VERSION;
  const unsupportedHosts = Array.from(new Map(overview.data.entries
    .filter((entry) => !entry.entryHost.versionSupported)
    .map((entry) => [entry.entryHost.id, entry.entryHost] as const)).values());
  const migrationNotice = (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>升级面板后，现有转发链 SNI 入口监听统一切换为入口分流器，切换时现有连接会发生一次中断。</p>
      <p>完成切换后，新增、修改和删除规则采用分流表热更新，仅实际变更规则的连接可能受到影响。</p>
    </div>
  );

  if (unsupportedHosts.length === 0) {
    return (
      <div className="space-y-2 border-t border-border/50 pt-3">
        <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>SNI 入口 Agent 均满足最低版本 {minimumVersion}</span>
        </div>
        {migrationNotice}
      </div>
    );
  }

  return (
    <Alert className="min-w-0 border-amber-500/30 bg-amber-500/5">
      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle>SNI 入口 Agent 需要升级</AlertTitle>
      <AlertDescription className="min-w-0 space-y-2 text-xs">
        <p>以下入口主机需要 Agent {minimumVersion} 或更高版本；版本不足时，SNI 分流规则将停止运行。</p>
        {migrationNotice}
        <div className="space-y-1">
          {unsupportedHosts.map((host) => (
            <div key={host.id} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="min-w-0 break-words font-medium">{host.name || `主机 #${host.id}`}</span>
              <span className="min-w-0 max-w-full shrink-0 break-all font-mono text-muted-foreground">{host.agentVersion ? `v${host.agentVersion}` : "版本未上报"}</span>
            </div>
          ))}
        </div>
        <Button asChild variant="link" size="sm" className="h-auto justify-start gap-1 px-0 py-0 text-xs">
          <Link href="/sni-entry-ports">查看 SNI 入口<ArrowRight className="h-3.5 w-3.5" /></Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
