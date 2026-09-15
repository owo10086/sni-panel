import { AlertTriangle, Rocket, Terminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDockerUpgradeCommand, type DockerUpgradeMethod } from "@/lib/panelUpgrade";

type DockerUpgradeCommandsProps = {
  scriptCommand: string;
  method: DockerUpgradeMethod;
  onMethodChange: (method: DockerUpgradeMethod) => void;
};

export function DockerUpgradeCommands({ scriptCommand, method, onMethodChange }: DockerUpgradeCommandsProps) {
  return (
    <Tabs
      value={method}
      onValueChange={(value) => {
        if (value === "script" || value === "manual") onMethodChange(value);
      }}
      className="min-w-0"
    >
      <TabsList className="grid w-full grid-cols-2" aria-label="Docker 升级方式">
        <TabsTrigger value="script" className="min-w-0 gap-2">
          <Rocket className="h-4 w-4 shrink-0" />
          一键脚本
        </TabsTrigger>
        <TabsTrigger value="manual" className="min-w-0 gap-2">
          <Terminal className="h-4 w-4 shrink-0" />
          手动升级
        </TabsTrigger>
      </TabsList>
      {(["script", "manual"] as const).map((value) => (
        <TabsContent key={value} value={value} className="min-w-0 space-y-3 pt-2">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{value === "manual" ? "保留现有 Compose 部署配置" : "适用于一键脚本管理的部署"}</AlertTitle>
            <AlertDescription className="break-words leading-relaxed">
              {value === "manual"
                ? "部署目录、项目名、服务名和容器名须与原部署一致。固定镜像标签时，先更新 .env 或 Compose 文件中的镜像版本。升级前备份数据库和配置，确认容器正常运行后再执行最后三行旧镜像清理命令。"
                : "脚本会重新生成部署目录中的 docker-compose.yml 和 .env，并重建 ForwardX 容器。自定义配置可能被覆盖，升级前请备份数据库和部署配置。"}
            </AlertDescription>
          </Alert>
          <pre className="max-h-64 min-w-0 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
            <code className="font-mono">{getDockerUpgradeCommand(value, scriptCommand)}</code>
          </pre>
        </TabsContent>
      ))}
    </Tabs>
  );
}
