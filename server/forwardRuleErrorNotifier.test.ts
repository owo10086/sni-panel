import assert from "node:assert/strict";
import test from "node:test";
import { pruneForwardRuleErrorNotifyCache, shouldNotifyForwardRuleError, portOccupancyNotificationTransition } from "./forwardRuleErrorNotifier";

test("forward-rule notification cooldown expires and dynamic messages remain bounded by time", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now), true);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now + 1_000), false);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.2 failed", now + 1_000), true);
  assert.equal(pruneForwardRuleErrorNotifyCache(now + 6 * 60 * 1000), 2);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now + 6 * 60 * 1000), true);
});

test("port occupancy notifications follow verified owner changes and recovery with cooldown", () => {
  const time = 1_800_000_000_000;
  assert.equal(portOccupancyNotificationTransition("rule:501:host:1", "127.0.0.1:11127:code", true, time), "occupied");
  assert.equal(portOccupancyNotificationTransition("rule:501:host:1", "127.0.0.1:11127:code", true, time + 100), null);
  assert.equal(portOccupancyNotificationTransition("rule:501:host:1", "127.0.0.1:11127:other", true, time + 100), null);
  assert.equal(portOccupancyNotificationTransition("rule:501:host:1", "", false, time + 600_000), null);
  assert.equal(portOccupancyNotificationTransition("rule:501:host:1", "", true, time + 600_001), "recovered");
  assert.equal(portOccupancyNotificationTransition("rule:501:host:1", "", true, time + 600_002), null);
  assert.equal(portOccupancyNotificationTransition("rule:502:host:1", "127.0.0.1:11127:code", true, time), "occupied");
  assert.equal(portOccupancyNotificationTransition("rule:502:host:1", "127.0.0.1:11127:other", true, time + 600_001), "occupied");
  assert.equal(portOccupancyNotificationTransition("rule:503:host:1", "owner-a", true, time), "occupied");
  assert.equal(portOccupancyNotificationTransition("rule:503:host:1", "owner-b", true, time + 500), null);
  assert.equal(portOccupancyNotificationTransition("rule:503:host:1", "owner-b", true, time + 600_001), "occupied");
});
