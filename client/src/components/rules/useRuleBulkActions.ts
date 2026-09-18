import { useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { batchOperationErrorMessage, chunkBatchItems, runBatchOperations } from "@/lib/batchOperations";
import {
  summarizeRuleBulkDeleteResult, summarizeRuleBulkResult,
  type RuleBulkEditInput, type RuleBulkOutcome, type RuleBulkRule,
} from "@/lib/ruleBulkSelection";
import type { RuleBulkSelection } from "./useRuleBulkSelection";

type DeleteResult = { deletedIds: number[]; failures: Array<{ id: number; error: string }> };

export function useRuleBulkActions<T extends RuleBulkRule>({ selection, editRules, deleteRules, onChanged }: {
  selection: RuleBulkSelection<T>;
  editRules: (rules: readonly T[], input: RuleBulkEditInput) => Promise<RuleBulkOutcome[]>;
  deleteRules: (ids: number[]) => Promise<DeleteResult>;
  onChanged: (ids: number[]) => Promise<unknown>;
}) {
  const confirmDialog = useConfirmDialog();
  const [dialogScope, setDialogScope] = useState<string | null>(null);
  const working = useRef(false);
  const dialogOpen = dialogScope === selection.scopeKey && selection.selectedRules.length > 0;
  const disabled = !selection.ready || selection.busy || selection.selectedRules.length === 0;

  const finish = async (outcomes: RuleBulkOutcome[], scopeKey: string, deleting = false) => {
    const summary = deleting ? summarizeRuleBulkDeleteResult(outcomes) : summarizeRuleBulkResult(outcomes);
    selection.retain(summary.keepSelectedIds, scopeKey);
    if (summary.closeDialog) setDialogScope(null);
    toast[summary.tone](summary.message);
    const changedIds = outcomes.filter((result) => result.outcome === "updated").map((result) => result.ruleId);
    try {
      await onChanged(changedIds);
    } catch (error) {
      toast.error(`刷新规则列表失败：${batchOperationErrorMessage(error)}`);
    }
  };

  const apply = async (input: RuleBulkEditInput) => {
    if (disabled || working.current) return;
    working.current = true;
    selection.setBusy(true);
    const scopeKey = selection.scopeKey;
    try {
      await finish(await editRules(selection.selectedRules, input), scopeKey);
    } catch (error) {
      toast.error(`批量编辑处理失败：${batchOperationErrorMessage(error)}`);
    } finally {
      working.current = false;
      selection.setBusy(false);
    }
  };

  const remove = async () => {
    if (disabled || working.current) return;
    working.current = true;
    selection.setBusy(true);
    const scopeKey = selection.scopeKey;
    const ids = [...selection.selectedIds];
    try {
      if (!(await confirmDialog({
        title: "删除转发规则", description: `确认删除选中的 ${ids.length} 条转发规则？`,
        confirmText: "删除", tone: "destructive",
      }))) return;
      const results = await runBatchOperations(chunkBatchItems(ids, 500), 2, deleteRules);
      const outcomes = results.flatMap((result): RuleBulkOutcome[] => result.status === "rejected"
        ? result.item.map((ruleId) => ({ ruleId, outcome: "failed", error: batchOperationErrorMessage(result.reason) }))
        : [
          ...result.value.deletedIds.map((ruleId): RuleBulkOutcome => ({ ruleId, outcome: "updated" })),
          ...result.value.failures.map((failure): RuleBulkOutcome => ({ ruleId: failure.id, outcome: "failed", error: failure.error })),
        ]);
      await finish(outcomes, scopeKey, true);
    } catch (error) {
      toast.error(`批量删除失败：${batchOperationErrorMessage(error)}`);
    } finally {
      working.current = false;
      selection.setBusy(false);
    }
  };
  return {
    dialogOpen, disabled, apply, remove,
    openDialog: () => { if (!disabled) setDialogScope(selection.scopeKey); },
    onOpenChange: (open: boolean) => { if (!selection.busy) setDialogScope(open ? selection.scopeKey : null); },
  };
}
