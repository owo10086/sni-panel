import type { ReactNode } from "react";
import { t } from "@/i18n";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function splitRuleTableItems<T extends {kind: string}>(items: T[]): T[][] {
  const blocks: T[][] = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (item.kind === "rule" && last?.[0]?.kind === "rule") last.push(item);
    else blocks.push([item]);
  }
  return blocks;
}

export function ruleTableColumnCount(sni: boolean, sorting = false) {
  return 8 + Number(sni) + Number(sorting);
}

/** Each display block owns its header and widths; mixed lists retain their order. */
export function RuleTableFrame({sni, sorting = false, selection, children}: {
  sni: boolean;
  sorting?: boolean;
  selection?: ReactNode;
  children: ReactNode;
}) {
  const columns = [
    {label:t("规则"),width:180},
    ...(sorting ? [{label:t("排序"),width:44}] : []),
    ...(sni ? [{label:t("SNI 域名"),width:190}] : []),
    {label:t("所属资源"),width:185},
    {label:t("转发入口"),width:235},
    {label:t("转发出口"),width:220},
    {label:t("协议"),width:70},
    {label:t("累计"),width:145},
    {label:t("延迟"),width:145},
    {label:t("操作"),width:180},
  ];
  return <div className="[container-type:inline-size]"><Table className="table-fixed" style={{minWidth:columns.reduce((sum,column) => sum + column.width,0)}}>
    <colgroup>{columns.map((column,index) => <col key={index} style={{width:column.width}} />)}</colgroup>
    <TableHeader><TableRow className="hover:bg-transparent">
      {columns.map((column,index) => <TableHead key={index} className={index === 0 ? "sticky left-0 z-10 bg-card" : index === columns.length - 1 ? "sticky right-0 z-10 bg-card text-right" : "whitespace-nowrap"}>
        {index === 0 ? <span className="flex items-center gap-2">{selection}{column.label}</span> : column.label}
      </TableHead>)}
    </TableRow></TableHeader>
    <TableBody>{children}</TableBody>
  </Table></div>;
}
