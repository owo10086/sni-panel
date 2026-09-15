import assert from "node:assert/strict";
import test from "node:test";

import {
  SNI_DEFAULT_ENTRY_PORT,
  applySniToggle,
  clearSniFromForm,
  closedSniToggleState,
  isSniFormModeOn,
  sniDomainFormatError,
  sniRuleRouteModeForEdit,
  sniToggleStateForRule,
  sniToggleSupport,
  type SniRuleFormSlice,
} from "./sniRuleForm";

const baseForm: SniRuleFormSlice = {
  sourcePort: 1103,
  sni: "",
  rateLimitMbps: 0,
  maxConnections: 0,
  protocol: "both",
  failoverEnabled: true,
  failoverTargetsText: "203.0.113.9:443",
};

test("拨开开关锁定 443 并记住原来的端口", () => {
  const { form, state } = applySniToggle(baseForm, closedSniToggleState, true);
  assert.equal(form.sourcePort, SNI_DEFAULT_ENTRY_PORT);
  assert.equal(form.protocol, "tcp");
  assert.equal(form.failoverEnabled, false);
  assert.equal(form.failoverTargetsText, "");
  assert.deepEqual(state, { enabled: true, portBeforeSni: 1103, portUnlocked: false });
});

test("拨回开关清空域名与限速，并还原打开前的端口", () => {
  const opened = applySniToggle(baseForm, closedSniToggleState, true);
  const filled = {
    ...opened.form,
    sni: "api.example.com",
    rateLimitMbps: 100,
    maxConnections: 200,
  };
  const closed = applySniToggle(filled, opened.state, false);
  assert.equal(closed.form.sourcePort, 1103);
  assert.equal(closed.form.sni, "");
  assert.equal(closed.form.rateLimitMbps, 0);
  assert.equal(closed.form.maxConnections, 0);
  assert.deepEqual(closed.state, closedSniToggleState);
});

test("编辑一条 8443 的已有 SNI 规则时端口不被改写为 443", () => {
  const state = sniToggleStateForRule({ sni: "api.example.com", sourcePort: 8443 });
  assert.deepEqual(state, { enabled: true, portBeforeSni: 8443, portUnlocked: false });
  // 开关本来就是开的，重复应用同一个值不应该动表单
  const form = { ...baseForm, sourcePort: 8443, sni: "api.example.com" };
  assert.equal(applySniToggle(form, state, true).form.sourcePort, 8443);
});

test("编辑关联资源尚未取得的 SNI 规则时暂不推导路由类型", () => {
  const rule = { forwardGroupId: 10, tunnelId: null, forwardType: "nftables" };
  assert.equal(sniRuleRouteModeForEdit(rule, null), null);
  assert.equal(sniRuleRouteModeForEdit(rule, "chain"), "chain");
  assert.equal(sniRuleRouteModeForEdit(rule, "port"), "local");
});

test("编辑一条 8443 的 SNI 规则时拨关再拨开，端口先回到 8443 再变成 443", () => {
  const opened = sniToggleStateForRule({ sni: "api.example.com", sourcePort: 8443 });
  const form = { ...baseForm, sourcePort: 8443, sni: "api.example.com", protocol: "tcp" as const };
  const closed = applySniToggle(form, opened, false);
  assert.equal(closed.form.sourcePort, 8443);
  const reopened = applySniToggle(closed.form, closed.state, true);
  assert.equal(reopened.form.sourcePort, SNI_DEFAULT_ENTRY_PORT);
  assert.equal(reopened.state.portBeforeSni, 8443);
});

test("普通转发规则反推出来的开关是关闭的", () => {
  assert.deepEqual(sniToggleStateForRule({ sni: null, sourcePort: 1103 }), closedSniToggleState);
  assert.deepEqual(sniToggleStateForRule({ sni: "   ", sourcePort: 1103 }), closedSniToggleState);
});

test("普通用户看不到开关", () => {
  assert.deepEqual(
    sniToggleSupport({ isAdmin: false, routeMode: "chain", group: { groupType: "host", members: [] } }),
    { visible: false, reason: null, pending: false },
  );
});

test("转发组模式下开关置灰", () => {
  const support = sniToggleSupport({ isAdmin: true, routeMode: "group" });
  assert.equal(support.visible, true);
  assert.match(String(support.reason), /转发组不支持/);
});

test("多出口隧道与负载均衡隧道置灰，单出口隧道可用", () => {
  assert.match(
    String(sniToggleSupport({ isAdmin: true, routeMode: "tunnel", tunnel: { exitGroupId: 7, exitHostId: 3 } }).reason),
    /仅支持单出口/,
  );
  assert.match(
    String(sniToggleSupport({ isAdmin: true, routeMode: "tunnel", tunnel: { loadBalanceEnabled: true, exitHostId: 3 } }).reason),
    /仅支持单出口/,
  );
  assert.equal(
    sniToggleSupport({ isAdmin: true, routeMode: "tunnel", tunnel: { exitHostId: 3 } }).reason,
    null,
  );
});

test("端口转发资源必须且只能含一台启用主机", () => {
  const twoHosts = {
    isAdmin: true,
    routeMode: "local" as const,
    groupModeForRule: "port" as const,
    group: { groupType: "host", members: [{ memberType: "host" }, { memberType: "host" }] },
  };
  assert.match(String(sniToggleSupport(twoHosts).reason), /只能包含一台主机/);
  const oneHost = {
    ...twoHosts,
    group: { groupType: "host", members: [{ memberType: "host" }, { memberType: "host", isEnabled: false }] },
  };
  assert.equal(sniToggleSupport(oneHost).reason, null);
});

test("非主机型资源与未选资源都置灰", () => {
  assert.match(
    String(sniToggleSupport({
      isAdmin: true,
      routeMode: "chain",
      groupModeForRule: "chain",
      group: { groupType: "group", members: [{ memberType: "host" }] },
    }).reason),
    /主机型/,
  );
  assert.match(
    String(sniToggleSupport({ isAdmin: true, routeMode: "local", groupModeForRule: null, group: null }).reason),
    /已保存的端口转发/,
  );
});

test("转发链允许多台主机成员", () => {
  assert.equal(
    sniToggleSupport({
      isAdmin: true,
      routeMode: "chain",
      groupModeForRule: "chain",
      group: { groupType: "host", members: [{ memberType: "host" }, { memberType: "host" }] },
    }).reason,
    null,
  );
});

test("域名格式错误有提示，空值和合法域名没有", () => {
  assert.equal(sniDomainFormatError(""), null);
  assert.equal(sniDomainFormatError("API.Example.COM."), null);
  assert.match(String(sniDomainFormatError("https://api.example.com")), /格式不正确/);
  assert.match(String(sniDomainFormatError("*.example.com")), /格式不正确/);
});

test("清空 SNI 字段时保持引用不变以免触发多余渲染", () => {
  const plain = { ...baseForm };
  assert.equal(clearSniFromForm(plain), plain);
  const cleared = clearSniFromForm({ ...baseForm, sni: "api.example.com", rateLimitMbps: 10 });
  assert.equal(cleared.sni, "");
  assert.equal(cleared.rateLimitMbps, 0);
});

test("资源尚未加载出来时标记为 pending，调用方不得据此清空表单", () => {
  const loading = sniToggleSupport({ isAdmin: true, routeMode: "tunnel", tunnel: null, tunnelId: 7 });
  assert.equal(loading.pending, true);
  assert.equal(loading.reason, "请先选择隧道");
  const chainLoading = sniToggleSupport({ isAdmin: true, routeMode: "chain", group: null, groupId: 9 });
  assert.equal(chainLoading.pending, true);
  const reallyUnsupported = sniToggleSupport({ isAdmin: true, routeMode: "group" });
  assert.equal(reallyUnsupported.pending, false);
  const nothingSelected = sniToggleSupport({ isAdmin: true, routeMode: "local", group: null, groupId: 0 });
  assert.equal(nothingSelected.pending, false);
});

test("编辑已有 SNI 规则时资源加载状态仍保持分流表单", () => {
  const loading = sniToggleSupport({ isAdmin: true, routeMode: "tunnel", tunnel: null, tunnelId: 7 });
  assert.equal(isSniFormModeOn({ enabled: true }, loading), true);
  assert.equal(isSniFormModeOn({ enabled: false }, loading), false);
  assert.equal(isSniFormModeOn({ enabled: true }, sniToggleSupport({ isAdmin: true, routeMode: "group" })), false);
});
