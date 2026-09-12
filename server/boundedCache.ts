export function setBoundedMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  if (map.has(key)) map.delete(key);
  while (map.size >= Math.max(1, maxSize)) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

/**
 * Same bound as setBoundedMapValue, but an existing key keeps its position
 * instead of moving to the tail.
 *
 * Use this — never setBoundedMapValue — while iterating the map being written
 * to. A Map iterator is live: a key deleted and re-inserted lands at the tail
 * and gets visited again, so refreshing entries inside a `for...of` over the
 * same map never terminates. The cost is that an entry refreshed this way ages
 * out by first write rather than by last write.
 */
export function updateBoundedMapValueInPlace<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  if (map.has(key)) {
    map.set(key, value);
    return;
  }
  setBoundedMapValue(map, key, value, maxSize);
}

export function pruneMapEntries<K, V>(map: Map<K, V>, shouldDelete: (value: V, key: K) => boolean) {
  let deleted = 0;
  for (const [key, value] of map) {
    if (!shouldDelete(value, key)) continue;
    map.delete(key);
    deleted += 1;
  }
  return deleted;
}
