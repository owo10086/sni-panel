export default function AppLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border/50 bg-card shadow-sm">
          <img src="/logo-light.png" alt="ForwardX" className="h-11 w-11 object-contain" />
        </div>
        <svg className="h-8 w-8 text-primary" viewBox="0 0 32 32" aria-hidden="true">
          <circle
            cx="16"
            cy="16"
            r="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            opacity="0.2"
          />
          <circle
            cx="16"
            cy="16"
            r="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="24 58"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 16 16"
              to="360 16 16"
              dur="0.85s"
              repeatCount="indefinite"
            />
          </circle>
        </svg>
        <p className="text-sm font-medium">加载中</p>
      </div>
    </div>
  );
}
