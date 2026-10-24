import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SelfTestEvidenceNote } from "./SelfTestEvidenceNote";

const html = (result: any) => renderToStaticMarkup(<SelfTestEvidenceNote result={result} />);

test("a reachable target is shown with its path still unverified, never as a verified forwarding success", () => {
  const markup = html({ id: 1, status: "success", latencyMs: 147, targetReachable: true, forwardOk: true, listenOk: true });
  assert.match(markup, /目标连接成功/);
  assert.match(markup, /外部经入口的转发路径/);
  assert.match(markup, /未验证/);
  assert.doesNotMatch(markup, /已验证|转发成功|转发正常|入口可用/, "an old unconditional success flag must not surface as verification");
});

test("a failed target and an unverified path are stated separately", () => {
  const markup = html({ id: 2, status: "failed", targetReachable: false, forwardOk: false });
  assert.match(markup, /目标连接失败/);
  assert.match(markup, /未验证/);
  assert.doesNotMatch(markup, /转发路径[^<]*失败/, "an untested path is not reported as a failed one");
});

test("the note follows the server's evidence when it provides one", () => {
  const markup = html({ id: 3, status: "success", evidence: { target: "unknown", externalPath: "unverified" } });
  assert.match(markup, /目标连接状态未知/);
});

test("older responses without evidence are read by the stored result", () => {
  assert.match(html({ id: 4, status: "success", targetReachable: true }), /目标连接成功/);
  assert.match(html({ id: 5, status: "timeout", targetReachable: false }), /目标连接状态未知/);
});

test("nothing is claimed while a test is still running or when there is no result", () => {
  assert.equal(html({ id: 6, status: "running", targetReachable: false }), "");
  assert.equal(html({ id: 7, status: "pending", targetReachable: false }), "");
  assert.equal(html(null), "");
  assert.equal(html(undefined), "");
});
