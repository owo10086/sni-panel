import type { CSSProperties, ReactNode } from "react";
import { t } from "@/i18n";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import ListSettings from "@/components/ListSettings";
import ColumnResizeHandle from "@/components/ColumnResizeHandle";
import { defaultRuleTableLayout, ruleTableColumns, type RuleTableLayout } from "@shared/ruleTableLayout";

export function splitRuleTableItems<T extends {kind: string}>(items: T[]): T[][] {
  const blocks: T[][] = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (item.kind === "rule" && last?.[0]?.kind === "rule") last.push(item);
    else blocks.push([item]);
  }
  return blocks;
}

export function ruleTableColumnCount(sni: boolean, _sorting = false, layout = defaultRuleTableLayout(), isAdmin = false) {
  return ruleTableColumns(layout, isAdmin, false, sni).length + 1;
}

/** Each display block owns its header and widths; mixed lists retain their order. */
export function RuleTableFrame({sni, selection, children, layout = defaultRuleTableLayout(), isAdmin = false, onLayoutChange, onResetLayout}: {
  sni: boolean;
  sorting?: boolean;
  selection?: ReactNode;
  children: ReactNode;
  layout?: RuleTableLayout;
  isAdmin?: boolean;
  onLayoutChange?: (layout: RuleTableLayout) => void;
  onResetLayout?: () => void;
}) {
  const columns = ruleTableColumns(layout, isAdmin, false, sni);
  const allColumns = ruleTableColumns(layout, isAdmin, true, sni);
  return <div className="[container-type:inline-size]"><Table floatingScrollbar className="table-fixed" style={{
    ...Object.fromEntries(columns.map(column => [`--list-col-${column.id}`, `${column.width}px`])),
    width: `max(100%, calc(${["44px", ...columns.map(column => `var(--list-col-${column.id})`)].join(" + ")}))`,
  } as CSSProperties}>
    <colgroup><col className="w-[44px]" />{columns.map(column => <col key={column.id} style={{width: column.id === columns.at(-1)?.id ? undefined : `var(--list-col-${column.id})`}} />)}</colgroup>
    <TableHeader><TableRow className="hover:bg-transparent">
      <TableHead className="sticky left-0 z-20 w-[44px] bg-card px-2 text-center">
        {onLayoutChange && onResetLayout && <ListSettings columns={allColumns} layout={layout} onChange={onLayoutChange} onReset={onResetLayout} />}
      </TableHead>
      {columns.map(column => <TableHead key={column.id} className={column.id === "name" ? "sticky left-[44px] z-10 bg-card px-3 pr-4" : column.id === "actions" ? "sticky right-0 z-10 bg-card px-3 pr-4 text-right" : "relative whitespace-nowrap px-3 pr-4"}>
        <span className="flex items-center gap-2">{column.id === "name" && selection}<span className="truncate" title={t(column.label)}>{t(column.label)}</span></span>
        {onLayoutChange && <ColumnResizeHandle column={column} onResize={width => onLayoutChange({...layout,widths:{...layout.widths,[column.id]:width}})} onReset={() => {
          const widths={...layout.widths}; delete widths[column.id]; onLayoutChange({...layout,widths});
        }} />}
      </TableHead>)}
    </TableRow></TableHeader>
    <TableBody>{children}</TableBody>
  </Table></div>;
}
