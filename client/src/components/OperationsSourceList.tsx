import { t } from "@/i18n";
import { PersistentPagination, type PersistentPaginationState } from "@/components/PersistentPagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type OperationsSourceSort } from "@shared/operations";
import { sourceUsage } from "./OperationsChinaMap";

type SourceRow = { ip: string; rules: number; bytesIn: number; bytesOut: number; knownSamples: number; unknownSamples: number };

export default function OperationsSourceList({ rows, total, pagination, sort, loading, onSortChange, onSelectIp }: {
  rows: SourceRow[]; total: number; pagination: PersistentPaginationState<SourceRow>; sort: OperationsSourceSort; loading: boolean;
  onSortChange: (sort: OperationsSourceSort) => void; onSelectIp: (ip: string) => void;
}) {
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{t("来源 IP")} <span className="ml-1 text-muted-foreground">{total}</span></span>
      <Select value={sort} onValueChange={value => onSortChange(value as OperationsSourceSort)}>
        <SelectTrigger aria-label={t("IP 排序")} className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="traffic">{t("流量优先")}</SelectItem><SelectItem value="rules">{t("规则数优先")}</SelectItem><SelectItem value="recent">{t("最近访问")}</SelectItem></SelectContent>
      </Select>
    </div>
    <div className="max-h-[28rem] overflow-auto rounded-lg border" aria-busy={loading}>
      <table className="w-full text-left text-sm"><thead className="sticky top-0 bg-card text-xs text-muted-foreground"><tr>
        <th className="px-3 py-2.5">#</th><th className="py-2.5">IP</th><th className="whitespace-nowrap px-2 py-2.5 text-right">{t("规则数")}</th><th className="whitespace-nowrap px-3 py-2.5 text-right">{t("采样流量")}</th>
      </tr></thead><tbody>
        {rows.map((row, index) => <tr key={row.ip} className="border-t hover:bg-muted/30">
          <td className="px-3 py-2.5 text-xs tabular-nums text-muted-foreground">{(pagination.currentPage - 1) * pagination.pageSize + index + 1}</td>
          <td className="py-2.5"><button className="block max-w-44 truncate font-mono text-xs text-primary hover:underline" title={row.ip} onClick={() => onSelectIp(row.ip)}>{row.ip}</button></td>
          <td className="px-2 text-right tabular-nums">{row.rules}</td>
          <td className="whitespace-nowrap px-3 text-right tabular-nums" title={row.unknownSamples ? t("部分流量不可用") : undefined}>{sourceUsage(row)}</td>
        </tr>)}
      </tbody></table>
      {!rows.length && <p className="py-6 text-center text-sm text-muted-foreground">{loading ? t("加载中") : t("暂无数据")}</p>}
    </div>
    <PersistentPagination pagination={pagination} />
  </div>;
}
