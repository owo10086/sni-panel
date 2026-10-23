import assert from "node:assert/strict";
import test from "node:test";
import {
  getSidebarMenuLabel,
  isSidebarMenuVisible,
  normalizeSidebarMenuSettings,
  SIDEBAR_MENU_KEYS,
  SIDEBAR_MENU_LABELS,
} from "./sidebarMenu";

test("ticket and affiliate entries are hidden by default", () => {
  const settings = normalizeSidebarMenuSettings();
  assert.equal(isSidebarMenuVisible(settings, "tickets"), false);
  assert.equal(isSidebarMenuVisible(settings, "affiliates"), false);
  assert.equal(isSidebarMenuVisible(settings), true);
});

test("every sidebar switch respects saved false and can be re-enabled", () => {
  for (const key of SIDEBAR_MENU_KEYS) {
    for (const enabled of [false, true]) {
      const saved = JSON.parse(JSON.stringify({ [key]: enabled }));
      assert.equal(isSidebarMenuVisible(normalizeSidebarMenuSettings(saved), key), enabled, key);
    }
  }
});

const entryVisibilityCases = [
  { isAdmin: false, menuEnabled: false, hasAffiliateHistory: false, affiliates: false, tickets: false },
  { isAdmin: false, menuEnabled: false, hasAffiliateHistory: true, affiliates: true, tickets: false },
  { isAdmin: false, menuEnabled: true, hasAffiliateHistory: false, affiliates: true, tickets: true },
  { isAdmin: false, menuEnabled: true, hasAffiliateHistory: true, affiliates: true, tickets: true },
  { isAdmin: true, menuEnabled: false, hasAffiliateHistory: false, affiliates: true, tickets: true },
  { isAdmin: true, menuEnabled: false, hasAffiliateHistory: true, affiliates: true, tickets: true },
  { isAdmin: true, menuEnabled: true, hasAffiliateHistory: false, affiliates: true, tickets: true },
  { isAdmin: true, menuEnabled: true, hasAffiliateHistory: true, affiliates: true, tickets: true },
];

for (const { isAdmin, menuEnabled, hasAffiliateHistory, affiliates, tickets } of entryVisibilityCases) {
  test(`entry visibility for ${isAdmin ? "admin" : "user"}, menu ${menuEnabled ? "shown" : "hidden"}, affiliate history ${hasAffiliateHistory ? "present" : "absent"}`, () => {
    const input = { tickets: menuEnabled, affiliates: menuEnabled, profile: false };
    const settings = normalizeSidebarMenuSettings(input);
    const viewer = { isAdmin, hasAffiliateHistory };
    assert.equal(isSidebarMenuVisible(settings, "affiliates", viewer), affiliates);
    assert.equal(isSidebarMenuVisible(settings, "tickets", viewer), tickets);
    assert.equal(isSidebarMenuVisible(settings, "profile", viewer), false);
    assert.deepEqual(settings, normalizeSidebarMenuSettings(input));
  });
}

test("affiliate labels match each role while other menu labels stay unchanged", () => {
  assert.equal(getSidebarMenuLabel("affiliates", true), "推广管理");
  assert.equal(getSidebarMenuLabel("affiliates"), "推广返佣");
  for (const key of SIDEBAR_MENU_KEYS.filter(key => key !== "affiliates")) {
    assert.equal(getSidebarMenuLabel(key, true), SIDEBAR_MENU_LABELS[key]);
    assert.equal(getSidebarMenuLabel(key, false), SIDEBAR_MENU_LABELS[key]);
  }
});
