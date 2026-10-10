import { t } from "./index";

// Some existing API responses use English instead of the catalog's Chinese
// source text. Normalize only known, exact messages at the presentation layer;
// do not change API errors, match arbitrary substrings, or translate diagnostics.
const messageAliases: Readonly<Record<string, string>> = {
  "User not found": "用户不存在",
};

export function translateNotificationText(message: string): string {
  const discordValidation = /^Discord Token 校验失败 \(HTTP ([1-5]\d{2})\)，原配置未修改$/.exec(message);
  if (discordValidation) return t("Discord Token 校验失败 (HTTP {0})，原配置未修改", [discordValidation[1]]);
  const source = Object.hasOwn(messageAliases, message) ? messageAliases[message] : message;
  return t(source);
}
