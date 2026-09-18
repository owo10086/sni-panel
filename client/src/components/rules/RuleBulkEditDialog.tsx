import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getRuleBulkRoutePreset, type RuleBulkEditInput, type RuleBulkRouteMode } from "@/lib/ruleBulkSelection";

type Resource = { id: number };
type Form = Omit<RuleBulkEditInput, "targetPort"> & { targetPortText: string };
const routeLabels: Record<RuleBulkRouteMode, string> = {
  local: "端口转发", tunnel: "隧道转发", chain: "转发链", group: "转发组",
};
const emptyForm = (routeMode: RuleBulkRouteMode | null): Form => ({
  routeMode, tunnelId: null, forwardGroupId: null, targetIp: "", targetPortText: "", conflictStrategy: "error",
});

export function RuleBulkEditDialog<T>({ open, onOpenChange, rules, getRouteMode, resources, renderResource, getResourceText, isValidTargetHost, disabled, busy, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: readonly T[];
  getRouteMode: (rule: T) => RuleBulkRouteMode;
  resources: Record<RuleBulkRouteMode, { enabled: boolean; items: readonly Resource[] }>;
  renderResource: (mode: RuleBulkRouteMode, resource: Resource) => ReactNode;
  getResourceText: (mode: RuleBulkRouteMode, resource: Resource) => string;
  isValidTargetHost: (value: string) => boolean;
  disabled: boolean;
  busy: boolean;
  onApply: (input: RuleBulkEditInput) => Promise<void>;
}) {
  const preset = getRuleBulkRoutePreset(rules, getRouteMode);
  const [form, setForm] = useState<Form>(() => emptyForm(preset.routeMode));
  const latestForm = useRef(form);
  const previousOpen = useRef(false);
  const fieldId = useId();
  useEffect(() => {
    if (open && !previousOpen.current) {
      const next = emptyForm(preset.routeMode);
      latestForm.current = next;
      setForm(next);
    }
    previousOpen.current = open;
  }, [open, preset.routeMode]);
  const update = (changes: Partial<Form>) => {
    const next = { ...latestForm.current, ...changes };
    latestForm.current = next;
    setForm(next);
  };
  const routeMode = form.routeMode;
  const resourceId = routeMode === "tunnel" ? form.tunnelId : form.forwardGroupId;
  const resourceSelected = routeMode !== null && resources[routeMode].enabled
    && resources[routeMode].items.some((item) => Number(item.id) === resourceId);
  const hasTarget = form.targetIp.trim().length > 0 || form.targetPortText.trim().length > 0;

  const apply = async () => {
    if (disabled) return;
    const snapshot = { ...latestForm.current };
    const targetIp = snapshot.targetIp.trim();
    const portText = snapshot.targetPortText.trim();
    const targetPort = portText ? Number(portText) : 0;
    if (targetIp && !isValidTargetHost(targetIp)) {
      toast.error("请输入有效的目标地址");
      return;
    }
    if (portText && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) {
      toast.error("目标端口必须是 1 至 65535 之间的整数");
      return;
    }
    const mode = snapshot.routeMode;
    const id = mode === "tunnel" ? snapshot.tunnelId : snapshot.forwardGroupId;
    const replaceResource = mode !== null && resources[mode].enabled
      && resources[mode].items.some((item) => Number(item.id) === id);
    if (!replaceResource && !targetIp && !portText) return;
    await onApply({
      routeMode: mode, tunnelId: replaceResource && mode === "tunnel" ? id : null,
      forwardGroupId: replaceResource && mode !== "tunnel" ? id : null,
      targetIp, targetPort, conflictStrategy: snapshot.conflictStrategy,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader className="pr-8">
          <DialogTitle>批量编辑 {rules.length} 条规则</DialogTitle>
          <DialogDescription>将对 {rules.length} 条规则生效</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4 overflow-y-auto pr-1">
          <section className="min-w-0 space-y-3 border-t border-border/60 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">替换入口资源</h3>
              <span className="text-xs text-muted-foreground">{resourceSelected ? "已设置新入口" : "保持原入口"}</span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-mode`}>入口类型</Label>
              <Select value={routeMode || ""} disabled={disabled} onValueChange={(value) => update({ routeMode: value as RuleBulkRouteMode, tunnelId: null, forwardGroupId: null })}>
                <SelectTrigger id={`${fieldId}-mode`} className="h-9"><SelectValue placeholder="选择入口类型" /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(routeLabels) as RuleBulkRouteMode[]).map((mode) => (
                    <SelectItem key={mode} value={mode} disabled={!resources[mode].enabled}>{routeLabels[mode]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {routeMode && (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`${fieldId}-resource`}>使用{routeMode === "tunnel" ? "隧道" : routeLabels[routeMode]}</Label>
                <Select value={resourceId ? String(resourceId) : "none"} disabled={disabled || !resources[routeMode].enabled} onValueChange={(value) => {
                  const id = value === "none" ? null : Number(value);
                  update(routeMode === "tunnel" ? { tunnelId: id, forwardGroupId: null } : { forwardGroupId: id, tunnelId: null });
                }}>
                  <SelectTrigger id={`${fieldId}-resource`} className="h-9 min-w-0 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不替换入口</SelectItem>
                    {resources[routeMode].items.map((resource) => (
                      <SelectItem key={resource.id} value={String(resource.id)} textValue={getResourceText(routeMode, resource)}>
                        {renderResource(routeMode, resource)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {preset.typeCount > 1 && (
              <p className="text-xs leading-5 text-muted-foreground">
                所选包含 {preset.typeCount} 种入口类型{resourceSelected && routeMode ? `，应用后会全部改为${routeLabels[routeMode]}` : "，保持原入口"}
              </p>
            )}
          </section>
          <section className="min-w-0 space-y-3 border-t border-border/60 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">替换转发出口</h3>
              <span className="text-xs text-muted-foreground">{hasTarget ? "按填写项替换" : "保持原目标"}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`${fieldId}-host`}>目标地址</Label>
                <Input id={`${fieldId}-host`} placeholder="留空则保持原目标地址" value={form.targetIp} disabled={disabled} onChange={(event) => update({ targetIp: event.target.value })} />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`${fieldId}-port`}>目标端口</Label>
                <Input id={`${fieldId}-port`} type="number" min={1} max={65535} step={1} placeholder="留空则保持原目标端口" value={form.targetPortText} disabled={disabled} onChange={(event) => update({ targetPortText: event.target.value })} />
              </div>
            </div>
          </section>
          <div className="min-w-0 space-y-1.5 border-t border-border/60 pt-3">
            <Label htmlFor={`${fieldId}-conflict`}>端口冲突处理</Label>
            <Select value={form.conflictStrategy} disabled={disabled || !resourceSelected} onValueChange={(value) => update({ conflictStrategy: value as RuleBulkEditInput["conflictStrategy"] })}>
              <SelectTrigger id={`${fieldId}-conflict`} className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">跳过冲突规则</SelectItem>
                <SelectItem value="auto">自动分配新端口</SelectItem>
                <SelectItem value="error">保持原端口，冲突则该条失败</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs leading-5 text-muted-foreground">SNI 分流规则共用同一入口端口，自动分配新端口会使同组规则分散到多个端口。</p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={disabled || (!resourceSelected && !hasTarget)} className="gap-1.5" onClick={() => void apply()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
