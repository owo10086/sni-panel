import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type RuleBulkCheckboxProps = {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  reason?: string | null;
  label: string;
  className?: string;
  compact?: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function RuleBulkCheckbox({ checked, indeterminate = false, disabled, reason, label, className, compact, onCheckedChange }: RuleBulkCheckboxProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span title={reason || label} className={cn("inline-flex shrink-0 items-center justify-center", compact ? "h-5 w-5" : "h-6 w-6", className)}>
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={reason ? `${label}：${reason}` : label}
        aria-checked={indeterminate ? "mixed" : checked}
        className={cn("shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50", compact ? "h-3.5 w-3.5" : "h-4 w-4")}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    </span>
  );
}
