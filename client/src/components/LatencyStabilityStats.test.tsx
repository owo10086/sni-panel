import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LatencyStabilityStats } from "./LatencyStabilityStats";
import { getLatencyStabilityStats } from "../lib/latencyChart";
import { initializeLanguage, setLanguagePreference, t } from "../i18n";

test("legacy health rows show latency without claiming accurate loss or serious unavailability", () => {
  const stats = getLatencyStabilityStats([{ latency: 8, probeCount: 3, probeSuccesses: 2 }], null);
  const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} failureLabel="TCP 连接失败率" counterStatistics={null} />);
  assert.match(html, /8 ms/);
  assert.match(html, /TCP 连接失败率/);
  assert.match(html, /请升级 Agent/);
  assert.doesNotMatch(html, /33\.33%|严重不可用|探测严重异常|10\/100/);
});

test("cumulative summary clearly labels independent per-hop probes and latest report coverage", () => {
  const counters = { total: 3000, successes: 2997, available: true, observedSince: new Date(), latestAt: new Date() };
  const stats = getLatencyStabilityStats([{ latency: 8 }], counters);
  const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} sampleLabel="逐跳探测次数"
    failureLabel="逐跳探测失败率" counterStatistics={counters} description="不是端到端业务丢包" />);
  assert.match(html, /3000/);
  assert.match(html, /0\.10%/);
  assert.match(html, /逐跳探测失败率/);
  assert.match(html, /不是端到端业务丢包/);
  assert.match(html, /截至/);
});

test("uniform Ping services keep the explicit Ping loss label", () => {
  const stats = getLatencyStabilityStats([{ latency: 8, probeCount: 5, probeSuccesses: 4 }]);
  const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} failureLabel="Ping 丢包率" />);
  assert.match(html, /Ping 丢包率/);
  assert.match(html, /20\.00%/);
  assert.doesNotMatch(html, /请升级 Agent/);
});

test("English distinguishes Ping, TCP and hop failures and declares bounded latency coverage", async () => {
  setLanguagePreference("en"); await initializeLanguage();
  try {
    const counters = { total: 9000, successes: 8997, available: true, observedSince: new Date(), latestAt: new Date(),
      latencySamples: [{ latency: 8, probeCount: 3, probeSuccesses: 3 }], latencySamplesTruncated: true };
    const stats = getLatencyStabilityStats([{ latency: 8 }], counters);
    for (const label of ["Ping 丢包率", "TCP 连接失败率", "逐跳探测失败率"]) {
      const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} failureLabel={t(label)} counterStatistics={counters} />);
      assert.match(html, /9000|9,000/);
      assert.match(html, /0\.03%/);
      assert.match(html, /2880|2,880/);
      assert.match(html, /all valid reports/);
      assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
    }
    const legacy = renderToStaticMarkup(<LatencyStabilityStats stats={getLatencyStabilityStats([{ latency: 8 }], null)} counterStatistics={null} />);
    assert.match(legacy, /cannot accurately calculate|accurate.*unavailable/i);
    assert.doesNotMatch(legacy, /[\u4e00-\u9fff]/);
  } finally { setLanguagePreference("zh-CN"); await initializeLanguage(); }
});
