export type RuleLatencyResult = {
  id:number; ruleId?:number; batchId?:string | null; status:string;
  latencyMs?:number | null; message?:string | null; updatedAt?:unknown;
};
export type RuleLatencySnapshot = {
  phase:"idle" | "testing" | "success" | "failed" | "timeout";
  result:RuleLatencyResult | null;
  message?:string;
  completedAt?:number;
};
export type RuleLatencyApi = {
  start:()=>Promise<{id:number;batchId?:string}>;
  latest:()=>Promise<RuleLatencyResult | null | undefined>;
};

/** Owns one rule's manual request; late responses cannot finish a newer run. */
export class RuleLatencyRunner {
  snapshot:RuleLatencySnapshot = {phase:"idle",result:null};
  private generation = 0;
  constructor(private changed:(snapshot:RuleLatencySnapshot)=>void,private timing = {pollMs:1500,timeoutMs:95_000}) {}
  private publish(snapshot:RuleLatencySnapshot) { this.snapshot=snapshot; this.changed(snapshot); }
  reset() { this.generation++; this.publish({phase:"idle",result:null}); }
  dispose() { this.generation++; }
  async start(api:RuleLatencyApi) {
    if (this.snapshot.phase === "testing") return false;
    const generation = ++this.generation;
    this.publish({phase:"testing",result:null});
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_,reject) => {timer=setTimeout(() => reject(new Error("timeout")),this.timing.timeoutMs);});
      const completed = await Promise.race([deadline,(async () => {
        const request = await api.start();
        if (!Number.isInteger(request.id) || request.id <= 0) throw new Error("invalid-test-id");
        while (generation === this.generation) {
          const result = await api.latest();
          if (generation !== this.generation) return null;
          const matches = result && (request.batchId ? result.batchId === request.batchId : Number(result.id) === request.id);
          if (matches && ["success","failed","timeout"].includes(result.status)) return result;
          // A newer unrelated test must never be treated as this request's result.
          if (result && Number(result.id) > request.id && !matches) throw new Error("test-superseded");
          await new Promise(resolve => setTimeout(resolve,this.timing.pollMs));
        }
        return null;
      })()]);
      if (generation === this.generation && completed) this.publish({phase:completed.status as "success" | "failed" | "timeout",result:completed,completedAt:Date.now()});
    } catch (error) {
      if (generation === this.generation) this.publish({phase:error instanceof Error && error.message === "timeout" ? "timeout" : "failed",result:null,message:error instanceof Error ? error.message : "",completedAt:Date.now()});
    } finally {
      if (timer) clearTimeout(timer);
      if (generation === this.generation) this.generation++;
    }
    return true;
  }
}
