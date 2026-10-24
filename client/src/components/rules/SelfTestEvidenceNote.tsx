import { t as translateText } from "@/i18n";
import { selfTestEvidence, type SelfTestEvidence } from "@shared/selfTestEvidence";

type SelfTestResult = { status?: string; targetReachable?: boolean; evidence?: SelfTestEvidence } & Record<string, unknown>;

const TARGET_TEXT = {
  reachable: "目标连接成功",
  unreachable: "目标连接失败",
  unknown: "目标连接状态未知",
} as const;

const LISTENER_TEXT = {
  reachable: "入口监听端口连接成功",
  unreachable: "入口监听端口连接失败",
  unknown: "入口监听端口连接状态未知",
} as const;

/**
 * What the latest self-test proves, in two separate facts: whether the probe
 * source reached the target, and whether a request from outside went through
 * the entry. The second is never established by these tests, so it is shown as
 * unverified rather than as a success or a failure.
 */
export function SelfTestEvidenceNote({ result }: { result?: SelfTestResult | null }) {
  if (!result) return null;
  const evidence = result.evidence ?? selfTestEvidence(result);
  // Older or cached evidence may lack the probe kind; the stored result tells it too.
  const listener = (evidence.probe ?? selfTestEvidence(result).probe) === "entry-listener";
  if (evidence.target === "pending") return null;
  const failed = evidence.target === "unreachable";
  const reachable = evidence.target === "reachable";
  return (
    <div role="note" className="space-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5">
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="text-muted-foreground">{translateText(listener ? "检测来源到入口监听端口" : "检测来源到目标")}</span>
        <span className={reachable ? "font-medium text-emerald-600 dark:text-emerald-400" : failed ? "font-medium text-red-600 dark:text-red-400" : "font-medium text-amber-600 dark:text-amber-400"}>
          {translateText((listener ? LISTENER_TEXT : TARGET_TEXT)[evidence.target])}
        </span>
      </p>
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="text-muted-foreground">{translateText("外部经入口的转发路径")}</span>
        <span className="font-medium text-amber-600 dark:text-amber-400">{translateText("未验证")}</span>
      </p>
      <p className="text-muted-foreground">
        {listener
          ? translateText("本检测只连接入口自身的监听端口，不能据此判断外部访问能否经入口到达最终目标。")
          : translateText("本检测只从检测来源直接连接目标，没有经入口业务端口发起请求，不能据此判断外部访问能否到达目标。")}
      </p>
    </div>
  );
}
