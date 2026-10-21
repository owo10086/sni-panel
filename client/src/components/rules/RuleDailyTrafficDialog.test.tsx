import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleDailyTrafficContent, totalRuleDailyTraffic } from "./RuleDailyTrafficDialog";

test("24 hour traffic includes every host of the logical rule after an entry switch", () => {
  const totals = totalRuleDailyTraffic([
    {ruleId:7,bytesIn:1024 ** 3,bytesOut:2 * 1024 ** 3},
    {ruleId:8,bytesIn:9 * 1024 ** 3,bytesOut:9 * 1024 ** 3},
    {ruleId:7,bytesIn:2 * 1024 ** 3,bytesOut:3 * 1024 ** 3},
  ],7);
  const html = renderToStaticMarkup(<RuleDailyTrafficContent loading={false} error={false} hasRecords totals={totals} />);
  assert.match(html,/入向.*3\.00 GB/);
  assert.match(html,/出向.*5\.00 GB/);
  assert.equal(totalRuleDailyTraffic(undefined,7),undefined);
});

test("24 hour traffic distinguishes missing records, actual zero counters, loading and failures", () => {
  const render = (props:Parameters<typeof RuleDailyTrafficContent>[0]) => renderToStaticMarkup(<RuleDailyTrafficContent {...props} />);
  const base = {loading:false,error:false,hasRecords:true,totals:{bytesIn:0,bytesOut:0}};
  assert.equal((render(base).match(/0 B/g) || []).length,2);
  assert.match(render({...base,hasRecords:false}),/暂无流量记录/);
  assert.doesNotMatch(render({...base,hasRecords:false}),/0 B/);
  assert.match(render({...base,loading:true}),/加载中/);
  assert.match(render({...base,error:true}),/流量读取失败/);
  const populated = render({...base,totals:{bytesIn:1024 ** 2,bytesOut:2 * 1024 ** 3}});
  assert.match(populated,/入向.*1\.00 MB/);
  assert.match(populated,/出向.*2\.00 GB/);
});
