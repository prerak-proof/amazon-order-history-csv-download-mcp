/**
 * Tests for the TTL memoization cache.
 */

import { TtlCache } from "../../../src/core/utils/memo-cache";

describe("TtlCache", () => {
  it("returns stored values before expiry", () => {
    let t = 1000;
    const cache = new TtlCache<string, number>(5000, 10, () => t);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
    t = 5999;
    expect(cache.get("a")).toBe(42);
  });

  it("expires entries after the TTL", () => {
    let t = 1000;
    const cache = new TtlCache<string, number>(5000, 10, () => t);
    cache.set("a", 42);
    t = 6000;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("returns undefined for missing keys", () => {
    const cache = new TtlCache<string, number>(5000);
    expect(cache.get("nope")).toBeUndefined();
  });

  it("evicts the oldest entry when full", () => {
    const cache = new TtlCache<string, number>(60000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("overwriting a key does not grow the cache", () => {
    const cache = new TtlCache<string, number>(60000, 2);
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(2);
  });

  it("clear empties the cache", () => {
    const cache = new TtlCache<string, number>(60000);
    cache.set("a", 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});
