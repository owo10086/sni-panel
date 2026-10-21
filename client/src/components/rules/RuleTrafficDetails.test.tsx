import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleTrafficDetailsContent } from "./RuleTrafficDetails";
import { RuleUsageSummary } from "./RuleUsageSummary";

test("desktop cumulative details preserve independent outbound quota and leave card units intact", () => {
  const rule = {adminManaged:true, trafficMode:"outbound",quotaUsedIn:1024,quotaUsedOut:2 * 1024 ** 3,trafficLimit:4 * 1024 ** 3};
  const html = renderToStaticMarkup(<RuleTrafficDetailsContent rule={rule} totals={{bytesIn:1024 ** 3,bytesOut:2 * 1024 ** 3}} />);
  assert.match(html,/3\.00 GB/);
  assert.match(html,/2\.00 GB/);
  assert.match(html,/4\.00 GB/);
  assert.match(html,/仅出向/);
  assert.match(html,/剩余/);
  assert.doesNotMatch(html,/GiB/);
  assert.match(renderToStaticMarkup(<RuleUsageSummary rule={rule} />),/GiB/);
});
