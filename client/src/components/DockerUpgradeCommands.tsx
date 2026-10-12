import { t as translateText } from "@/i18n";
import { AlertTriangle, Rocket, Terminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDockerUpgradeCommand, type DockerUpgradeMethod } from "@/lib/panelUpgrade";

type DockerUpgradeCommandsProps = {
  scriptCommand: string;
  targetVersion?: string | null;
  method: DockerUpgradeMethod;
  onMethodChange: (method: DockerUpgradeMethod) => void;
};

export function DockerUpgradeCommands({ scriptCommand, targetVersion, method, onMethodChange }: DockerUpgradeCommandsProps) {
  return (
    <Tabs
      value={method}
      onValueChange={(value) => {
        if (value === "script" || value === "manual") onMethodChange(value);
      }}
      className="min-w-0"
    >
      <TabsList className="grid w-full grid-cols-2" aria-label={translateText("Docker 升级方式")}>
        <TabsTrigger value="manual" className="min-w-0 gap-2">
          <Terminal className="h-4 w-4 shrink-0" />
          {translateText("手动升级")}</TabsTrigger>
        <TabsTrigger value="script" className="min-w-0 gap-2">
          <Rocket className="h-4 w-4 shrink-0" />
          {translateText("一键脚本")}</TabsTrigger>
      </TabsList>
      {(["script", "manual"] as const).map((value) => (
        <TabsContent key={value} value={value} className="min-w-0 space-y-3 pt-2">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{value === "manual" ? translateText("保留现有 Compose 部署配置") : translateText("适用于一键脚本管理的部署")}</AlertTitle>
            <AlertDescription className="break-words leading-relaxed">
              {value === "manual"
                ? translateText("命令会自动读取当前面板的部署目录，备份 docker-compose.yml，将镜像改为提示的新版本，再重建面板并核对版本。原有数据目录和其他服务保持不变。请用 root 执行；如修改过容器名，先调整命令中的 PANEL_CONTAINER。升级前请备份数据库。")
                : translateText("脚本会重新生成部署目录中的 docker-compose.yml 和 .env，并重建 ForwardX 容器。自定义配置可能被覆盖，升级前请备份数据库和部署配置。")}
            </AlertDescription>
          </Alert>
          <pre className="max-h-64 min-w-0 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
            <code className="font-mono">{getDockerUpgradeCommand(value, scriptCommand, targetVersion) || translateText("请先检查更新")}</code>
          </pre>
        </TabsContent>
      ))}
    </Tabs>
  );
}
