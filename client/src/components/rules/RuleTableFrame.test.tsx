import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleTableFrame, splitRuleTableItems } from "./RuleTableFrame";

test("SNI and ordinary rule tables expose the correct fields without hidden empty columns", () => {
  const render = (sni: boolean) => renderToStaticMarkup(<RuleTableFrame sni={sni}><tr><td>rule</td></tr></RuleTableFrame>);
  const sni = render(true);
  const ordinary = render(false);
  assert.match(sni, /SNI 域名/);
  assert.doesNotMatch(ordinary, /SNI 域名/);
  for (const html of [sni, ordinary]) {
    assert.match(html, /所属资源/);
    assert.match(html, /转发入口/);
    assert.match(html, /转发出口/);
    assert.match(html, /所属分组/);
    assert.match(html, />链路</);
    assert.match(html, />24H</);
    assert.match(html, /规则额度/);
    assert.doesNotMatch(html, />用户</);
    assert.equal((html.match(/<col(?=[\s/>])/g) || []).length, (html.match(/<th[ >]/g) || []).length);
  }
});

test("mixed lists keep SNI groups and adjacent ordinary runs in their original order", () => {
  const items = [{kind:"rule",key:"a"},{kind:"rule",key:"b"},{kind:"sni-group",key:"sni"},{kind:"rule",key:"c"}];
  const blocks = splitRuleTableItems(items);
  assert.deepEqual(blocks.map(block => block.map(item => item.key)), [["a","b"],["sni"],["c"]]);
  assert.equal(blocks[1][0], items[2]);
});
