import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import english from "./botLocale.en.json";

const language = new AsyncLocalStorage<"zh" | "en">();
export function botEnglish() { return language.getStore() === "en"; }
/** Call only with panel-owned text. Values and user content are never translated. */
export function botLabel(source: string) {
  return botEnglish() ? (english as Record<string, string>)[source] || source : source;
}
export function botText(parts: TemplateStringsArray, ...values: unknown[]) {
  const source = parts.reduce((text, part, index) => text + (index ? `{${index - 1}}` : "") + part, "");
  return botLabel(source).replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)]));
}
export async function withBotLocale<T>(provider: "telegram" | "discord", from: { id: string | number; language_code?: string } | undefined, task: () => Promise<T>) {
  if (!from) return task();
  const db = await import("./db");
  const { botAccounts } = await import("./botAccounts");
  const user = await botAccounts.getUserById(String(from.id));
  const key = `botLanguage:${createHash("sha256").update(JSON.stringify([provider, String(from.id)])).digest("hex")}`;
  const previous = await db.getSetting(key);
  const locale = from.language_code ? (/^zh(?:[-_]|$)/i.test(from.language_code) ? "zh" : "en") : previous === "en" ? "en" : "zh";
  if (user && user.accountEnabled !== false && from.language_code && previous !== locale) await db.setSetting(key, locale);
  return language.run(locale, task);
}
