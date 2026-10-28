import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { ACCOUNT_DISABLED_ERR_MSG } from "../../../shared/const";
import { retryAuthCheck, shouldRetryQuery } from "./queryPolicy";

test("auth query observer backs off transient failures, recovers, and stops on revoked credentials", async (t) => {
  // React Query disables browser polling on the server. Use its real observer
  // with browser detection and controlled timers; no query internals are mocked.
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000 });
  let calls = 0;
  let revoked = false;
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery } } });
  const observer = new QueryObserver(client, {
    queryKey: ["auth", "me"], refetchInterval: retryAuthCheck, retry: false,
    queryFn: async () => {
      calls++;
      if (revoked) throw new Error(ACCOUNT_DISABLED_ERR_MSG);
      if (calls <= 5) throw Object.assign(new Error("temporarily busy"), { data: { code: "SERVICE_UNAVAILABLE", httpStatus: 503 } });
      return { id: 7, username: "alice" };
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const settle = async () => { for (let index = 0; index < 3; index++) await nextTurn(); };
  try {
    await settle();assert.equal(calls, 1);assert.equal(observer.getCurrentResult().data, undefined);
    t.mock.timers.tick(4_999);await settle();assert.equal(calls, 1);
    t.mock.timers.tick(1);await settle();assert.equal(calls, 2);
    t.mock.timers.tick(9_999);await settle();assert.equal(calls, 2);
    t.mock.timers.tick(1);await settle();assert.equal(calls, 3);
    t.mock.timers.tick(19_999);await settle();assert.equal(calls, 3);
    t.mock.timers.tick(1);await settle();assert.equal(calls, 4);
    t.mock.timers.tick(29_999);await settle();assert.equal(calls, 4);
    t.mock.timers.tick(1);await settle();assert.equal(calls, 5);
    t.mock.timers.tick(29_999);await settle();assert.equal(calls, 5);
    t.mock.timers.tick(1);await settle();assert.equal(calls, 6);
    assert.deepEqual(observer.getCurrentResult().data, { id: 7, username: "alice" });
    t.mock.timers.tick(60_000);await settle();assert.equal(calls, 6, "healthy auth stops retry polling");
    revoked = true;await observer.refetch();await settle();
    const revokedError = observer.getCurrentResult().error;
    assert.ok(revokedError instanceof Error);
    assert.equal(revokedError.message, ACCOUNT_DISABLED_ERR_MSG);
    t.mock.timers.tick(60_000);await settle();assert.equal(calls, 7, "revoked credentials must not retry forever");
  } finally {
    unsubscribe();client.clear();t.mock.timers.reset();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
