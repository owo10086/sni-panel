from pathlib import Path
import os, subprocess, hashlib, json
source = Path("/private/tmp/forwardx-spec-review-jim69b9u")
evidence = Path("/private/tmp/task3-spec-review-evidence")
env = dict(os.environ, FORWARDX_LOG_DIR=str(source / "logs"))
cases = [
    ("baseline-debt", ["node", "--import", "tsx", "--test", "--test-name-pattern=member removal retries failed debt|member cleanup pauses existing debt", "server/groupMemberRelease.test.ts"]),
    ("baseline-history-css", ["node", "--import", "tsx", "--test", "--test-name-pattern=chain history counts|Web sidebar reserves", "server/latencyHistory.test.ts", "client/src/components/ui/pearl-ui.test.tsx"]),
]
results=[]
for name, command in cases:
    result=subprocess.run(command,cwd=source,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (evidence / (name + ".log")).write_bytes(result.stdout)
    results.append({"name":name,"command":command,"exitCode":result.returncode,"expectedExitCode":1})
paths=["server/repositories/forwardRuleRepository.ts","server/repositories/forwardGroupRepository.ts","server/repositories/metricsRepository.ts","client/src/index.css","server/groupMemberRelease.test.ts","server/latencyHistory.test.ts","client/src/components/ui/pearl-ui.test.tsx"]
report={"baseline":"c8e5c77622e5acce920f1e8ef856d920f29cfc44","purpose":"新检查配旧业务实现；预期抓住原问题而失败。此记录不验证后来MySQL调整。", "source":str(source),"sha256":{p:hashlib.sha256((source/p).read_bytes()).hexdigest() for p in paths},"results":results}
(evidence / "反向验证身份与命令.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
for row in results: print(row["name"],"exit",row["exitCode"])
if any(row["exitCode"]!=row["expectedExitCode"] for row in results): raise SystemExit(1)
