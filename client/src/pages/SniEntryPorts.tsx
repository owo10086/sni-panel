import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Network, RefreshCw, Search, Server } from "lucide-react";
import { useState } from "react";

function targetAddress(address: string, port: number) {
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${host}:${port}`;
}

function SniEntryPortsContent() {
  const [search, setSearch] = useState("");
  const overview = trpc.rules.sniEntryPortOverview.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const query = search.trim().toLowerCase();
  const entries = (overview.data?.entries || []).map((entry) => {
    const hostMatches = !query || [entry.entryHost.name, entry.entryHost.id, entry.sourcePort]
      .some((value) => String(value || "").toLowerCase().includes(query));
    return {
      ...entry,
      routes: hostMatches ? entry.routes : entry.routes.filter((route) => (
        [route.ruleName, route.sni, route.forwardGroup.name, route.target.address, route.target.port]
          .some((value) => String(value || "").toLowerCase().includes(query))
      )),
    };
  }).filter((entry) => entry.routes.length > 0);

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold sm:text-2xl">SNI 入口</h1>
          <Badge variant="outline">只读</Badge>
          {overview.data && <Badge variant="secondary">{overview.data.entries.length} 个入口端口</Badge>}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          title="刷新 SNI 入口"
          aria-label="刷新 SNI 入口"
          onClick={() => void overview.refetch()}
          disabled={overview.isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${overview.isFetching ? "forwardx-icon-spin" : ""}`} />
        </Button>
      </div>

      <div className="relative max-w-lg">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索入口主机、端口、域名、转发链或落地机"
          aria-label="搜索 SNI 入口"
          className="h-9 pl-9 text-sm"
        />
      </div>

      {overview.isLoading ? (
        <DataSectionLoading label="正在加载 SNI 入口" />
      ) : overview.isError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>SNI 入口加载失败</AlertTitle>
          <AlertDescription className="break-words">{overview.error.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          {!!overview.data?.unsupportedEntryHostCount && (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>入口 Agent 版本不足</AlertTitle>
              <AlertDescription>
                {overview.data.unsupportedEntryHostCount} 台入口主机需要 Agent {overview.data.minimumAgentVersion} 或更高版本。
              </AlertDescription>
            </Alert>
          )}
          {entries.length === 0 ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 border-y border-border/50 text-sm text-muted-foreground">
              <Network className="h-6 w-6" />
              <p>{query ? "没有符合搜索条件的 SNI 入口" : "暂无转发链 SNI 入口"}</p>
            </div>
          ) : (
            <div className="space-y-6">
              {entries.map((entry) => (
                <section key={`${entry.entryHost.id}:${entry.sourcePort}`} className="min-w-0 space-y-3 border-t border-border/60 pt-4">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
                        <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="break-words">{entry.entryHost.name || `主机 #${entry.entryHost.id}`}</span>
                        <span className="shrink-0 font-mono">:{entry.sourcePort}</span>
                        <Badge variant="secondary" className="shrink-0 text-[11px]">{entry.routes.length} 个域名</Badge>
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Agent {entry.entryHost.agentVersion ? `v${entry.entryHost.agentVersion}` : "版本未上报"}，最低版本 {overview.data?.minimumAgentVersion}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={entry.entryHost.versionSupported ? "outline" : "destructive"} className="shrink-0">
                        {entry.entryHost.versionSupported ? "版本满足要求" : "Agent 需要升级"}
                      </Badge>
                      {!entry.domainSetConsistent && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">域名集合存在差异</Badge>}
                    </div>
                  </div>
                  {!entry.domainSetConsistent && (
                    <div className="border-l-2 border-amber-500/60 pl-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
                      <p>同一入口端口在相关入口主机上的域名集合存在差异。</p>
                      {entry.missingDomains.length > 0 && <p className="break-words">本入口缺少域名：<span className="font-mono">{entry.missingDomains.join("、")}</span></p>}
                    </div>
                  )}
                  <div className="min-w-0 overflow-x-auto border-y border-border/40">
                    <Table className="min-w-[600px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[32%]">SNI 域名</TableHead>
                          <TableHead className="w-[28%]">转发链</TableHead>
                          <TableHead className="w-[30%]">落地机</TableHead>
                          <TableHead className="w-[10%] text-right">状态</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {entry.routes.map((route) => (
                          <TableRow key={route.ruleId}>
                            <TableCell>
                              <span className="break-all font-mono text-xs">{route.sni}</span>
                              <span className="mt-1 block break-words text-xs text-muted-foreground">{route.ruleName}</span>
                            </TableCell>
                            <TableCell className="break-words text-sm">{route.forwardGroup.name}</TableCell>
                            <TableCell className="break-all font-mono text-xs">{targetAddress(route.target.address, route.target.port)}</TableCell>
                            <TableCell className="text-right">
                              <Badge variant={route.isEnabled ? "secondary" : "outline"} className="whitespace-nowrap text-[11px]">
                                {route.isEnabled ? "启用" : "停用"}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function SniEntryPortsPage() {
  return (
    <DashboardLayout>
      <SniEntryPortsContent />
    </DashboardLayout>
  );
}
