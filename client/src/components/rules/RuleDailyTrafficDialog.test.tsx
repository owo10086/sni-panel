import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleDailyTrafficContent } from "./RuleDailyTrafficDialog";

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
