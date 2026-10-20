import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import RoutePage from "./RoutePage";
import { initializeLanguage, setLanguagePreference } from "@/i18n";
import { canPrefetchClientRoute, resolveClientRoute } from "../../../shared/clientRoutes";
import { getRouteModule } from "@/lib/routeModules";

test("local SNI entry page uses the lazy dashboard route and administrator prefetch gate", () => {
  assert.deepEqual(resolveClientRoute("/sni-entry-ports?view=hosts"), {
    path: "/sni-entry-ports", page: "SniEntryPorts", dashboard: true, admin: true,
  });
  assert.equal(canPrefetchClientRoute("/sni-entry-ports", "admin"), true);
  assert.equal(canPrefetchClientRoute("/sni-entry-ports", "user"), false);
  assert.equal(canPrefetchClientRoute("/sni-entry-ports"), false);
  assert.equal(getRouteModule("SniEntryPorts").getSnapshot().status, "idle");
});

test("route fallback is local, bilingual and does not start fetching other pages on render", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    setLanguagePreference(language);
    await initializeLanguage();
    const html = renderToStaticMarkup(<RoutePage page="Hosts" />);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /fixed|inset-0|min-h-screen|animate-pulse|<aside|<nav/);
    if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
  }
});
