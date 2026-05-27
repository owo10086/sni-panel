type AppLoadingScreenProps = {
  message?: string;
};

export default function AppLoadingScreen({ message = "正在加载 ForwardX" }: AppLoadingScreenProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border/50 bg-card shadow-sm">
          <img src="/logo-light.png" alt="ForwardX" className="h-11 w-11 object-contain dark:hidden" />
          <img src="/logo-dark.png" alt="ForwardX" className="hidden h-11 w-11 object-contain dark:block" />
        </div>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{message}</p>
          <p className="text-xs text-muted-foreground">请稍候，正在连接面板</p>
        </div>
      </div>
    </div>
  );
}
