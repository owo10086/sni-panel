import assert from "node:assert/strict";
import test from "node:test";
import { pruneMapEntries, setBoundedMapValue, updateBoundedMapValueInPlace } from "./boundedCache";

test("bounded maps evict the oldest entry and refresh updated keys", () => {
  const cache = new Map<string, number>();
  setBoundedMapValue(cache, "a", 1, 2);
  setBoundedMapValue(cache, "b", 2, 2);
  setBoundedMapValue(cache, "a", 3, 2);
  setBoundedMapValue(cache, "c", 4, 2);
  assert.deepEqual(Array.from(cache.entries()), [["a", 3], ["c", 4]]);

  assert.equal(pruneMapEntries(cache, (value) => value < 4), 1);
  assert.deepEqual(Array.from(cache.entries()), [["c", 4]]);
});

test("in-place updates terminate when the map being written to is iterated", () => {
  const cache = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
  let visited = 0;
  for (const [key, value] of cache) {
    visited += 1;
    // A live Map iterator revisits any key moved to the tail, so refreshing
    // entries here with setBoundedMapValue would spin forever.
    assert.ok(visited <= 10, "an entry was revisited after being updated");
    updateBoundedMapValueInPlace(cache, key, value * 10, 100);
  }
  assert.equal(visited, 3);
  assert.deepEqual(Array.from(cache.entries()), [["a", 10], ["b", 20], ["c", 30]]);
});

test("in-place updates still evict down to the bound when the key is new", () => {
  const cache = new Map<string, number>();
  for (const key of ["a", "b", "c"]) updateBoundedMapValueInPlace(cache, key, 1, 2);
  assert.deepEqual(Array.from(cache.keys()), ["b", "c"]);

  updateBoundedMapValueInPlace(cache, "b", 9, 2);
  assert.deepEqual(Array.from(cache.entries()), [["b", 9], ["c", 1]]);
});
