import { MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RuleBulkActionBar({ count, disabled, busy, onClear, onEdit, onDelete, onMore }: {
  count: number;
  disabled: boolean;
  busy: boolean;
  onClear: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMore: () => void;
}) {
  if (count === 0) return null;
  return (
    <div role="region" aria-label="所选规则批量操作" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-y border-border/60 bg-muted/25 px-2 py-2 sm:px-3">
      <span className="text-sm font-medium tabular-nums">已选 {count} 条（本页）</span>
      <Button type="button" variant="ghost" size="sm" disabled={busy} className="gap-1.5" onClick={onClear}>
        <X className="h-3.5 w-3.5" />清空
      </Button>
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
        <Button type="button" size="sm" disabled={disabled} className="gap-1.5" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />批量编辑
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled} className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />删除所选
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} className="gap-1.5" onClick={onMore}>
          <MoreHorizontal className="h-4 w-4" />更多批量操作
        </Button>
      </div>
    </div>
  );
}
