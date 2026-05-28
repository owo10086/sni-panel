export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "forwardx-default-secret-change-me",
  mysqlUrl: process.env.MYSQL_URL ?? "",
  mysqlHost: process.env.MYSQL_HOST ?? "",
  mysqlPort: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
  mysqlUser: process.env.MYSQL_USER ?? "",
  mysqlPassword: process.env.MYSQL_PASSWORD ?? "",
  mysqlDatabase: process.env.MYSQL_DATABASE ?? "",
  mysqlSsl: process.env.MYSQL_SSL === "true",
  mysqlConfigPath: process.env.MYSQL_CONFIG_PATH ?? "/data/mysql.json",
  databaseType: process.env.DATABASE_TYPE ?? process.env.DB_TYPE ?? "",
  databaseConfigPath: process.env.DATABASE_CONFIG_PATH ?? process.env.DB_CONFIG_PATH ?? "/data/database.json",
  sqlitePath: process.env.SQLITE_PATH ?? "/data/forwardx.db",
  port: Number.parseInt(process.env.PORT || "3000", 10),
  portConfigPath: process.env.FORWARDX_PORT_CONFIG_PATH ?? "",
  portManagement: process.env.FORWARDX_PORT_MANAGEMENT ?? "",
  // 管理后台一键升级命令。为空时只允许检查更新，不执行升级。
  // 执行时会注入 FORWARDX_TARGET_VERSION / FORWARDX_CURRENT_VERSION / FORWARDX_REPO_URL。
  upgradeCommand: process.env.FORWARDX_UPGRADE_COMMAND ?? "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramBotPolling: process.env.TELEGRAM_BOT_POLLING !== "false",
  isProduction: process.env.NODE_ENV === "production",
};
