import { RuleLatencyRunner, type RuleLatencyApi, type RuleLatencySnapshot } from "./ruleLatencyRunner";
import type { RuleProbeSummary } from "./ruleProbeCache";

const idle:RuleLatencySnapshot = {phase:"idle",result:null};
type Entry = {
  configurationKey:string;runner:RuleLatencyRunner;invalidatedAt:number;revision:number;
  requests:Map<string,number>;dispatches:Set<{revision:number}>;
};

export function ruleLatencyTimestamp(value:unknown):number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (value instanceof Date) return value.getTime();
  return value ? new Date(String(value)).getTime() || 0 : 0;
}

/** Page-owned tests survive row unmounts caused by folding, filtering and pagination. */
export class RuleLatencyStore {
  private entries = new Map<number,Entry>();
  private listeners = new Map<number,Set<()=>void>>();
  constructor(private timing = {pollMs:1500,timeoutMs:95_000},private now = () => Date.now()) {}

  configure(configurations:ReadonlyMap<number,string>) {
    for (const [ruleId,configurationKey] of configurations) {
      const entry = this.entries.get(ruleId);
      if (!entry) {
        this.entries.set(ruleId,{configurationKey,invalidatedAt:0,revision:0,requests:new Map(),dispatches:new Set(),runner:new RuleLatencyRunner(() => this.notify(ruleId),this.timing)});
        this.notify(ruleId);
      } else if (entry.configurationKey !== configurationKey) {
        entry.configurationKey=configurationKey;
        entry.invalidatedAt=this.now();
        entry.revision++;
        entry.runner.reset();
      }
    }
  }
  subscribe(ruleId:number,listener:()=>void) {
    let listeners=this.listeners.get(ruleId);
    if (!listeners) this.listeners.set(ruleId,listeners=new Set());
    listeners.add(listener);
    return () => {listeners.delete(listener);};
  }
  private notify(ruleId:number) {this.listeners.get(ruleId)?.forEach(listener => listener());}
  snapshot(ruleId:number,configurationKey:string) {
    const entry=this.entries.get(ruleId);
    return entry?.configurationKey === configurationKey ? entry.runner.snapshot : idle;
  }
  start(ruleId:number,configurationKey:string,api:RuleLatencyApi) {
    if (!this.entries.has(ruleId)) this.configure(new Map([[ruleId,configurationKey]]));
    const entry=this.entries.get(ruleId)!;
    if (entry.configurationKey !== configurationKey) return Promise.resolve(false);
    const revision=entry.revision;
    return entry.runner.start({...api,start:async () => {
      const dispatch={revision};
      entry.dispatches.add(dispatch);
      // A failed response cannot prove no request was queued. Keep unknown
      // ownership conservative across later edits until this start resolves.
      const request=await api.start();
      entry.requests.set(`id:${request.id}`,revision);
      if (request.batchId) entry.requests.set(`batch:${request.batchId}`,revision);
      entry.dispatches.delete(dispatch);
      return request;
    }});
  }
  acceptsSummary(ruleId:number,configurationKey:string,summary:RuleProbeSummary | undefined) {
    const entry=this.entries.get(ruleId);
    if (!entry || entry.configurationKey !== configurationKey) return false;
    const identity=summary?.latestLatencyBatchId ? `batch:${summary.latestLatencyBatchId}` : `id:${summary?.latestLatencyTestId}`;
    const revision=entry.requests.get(identity);
    if (revision !== undefined) return revision === entry.revision;
    if (Array.from(entry.dispatches).some(dispatch => dispatch.revision !== entry.revision)) return false;
    if (!entry.invalidatedAt) return true;
    // Completed-at may be newer even when a test started against an old target.
    // Legacy automatic samples have no trustworthy start; retain the manual
    // current result (or "untested") until a provably newer test is available.
    return ruleLatencyTimestamp(summary?.latestLatencyStartedAt) > entry.invalidatedAt;
  }
  reset(ruleIds:Iterable<number>) {
    for (const ruleId of ruleIds) {
      const entry=this.entries.get(ruleId);
      if (entry) {entry.invalidatedAt=this.now();entry.revision++;entry.runner.reset();}
    }
  }
  dispose() {for (const entry of this.entries.values()) entry.runner.dispose();}
}
