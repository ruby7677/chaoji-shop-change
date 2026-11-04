// 結帳門市清單的頁面內快取（public/expiring-cache.js）：同一世代只載入一次，失敗可重試，過期後整批重新載入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExpiringCache } from "../../public/expiring-cache.js";

function setup(ttl = 1000) {
  let time = 0;
  const calls = [];
  const cache = createExpiringCache(ttl, () => time);
  const load = (key, value = key) => () => { calls.push(key); return Promise.resolve(value); };
  return { cache, calls, load, advance: (ms) => { time += ms; } };
}

test("the same key loads once while the cache is fresh", async () => {
  const { cache, calls, load } = setup();
  await Promise.all([cache.get("index", load("index")), cache.get("index", load("index"))]);
  await cache.get("taipei", load("taipei"));
  assert.deepEqual(calls, ["index", "taipei"]);
});

test("after the ttl every key is reloaded together, so the index and city files come from one generation", async () => {
  const { cache, calls, load, advance } = setup();
  await cache.get("index", load("index"));
  await cache.get("taipei", load("taipei"));
  advance(1001);
  await cache.get("taipei", load("taipei"));
  await cache.get("index", load("index"));
  assert.deepEqual(calls, ["index", "taipei", "taipei", "index"]);
});

test("a failed load is dropped so the next call retries", async () => {
  const { cache } = setup();
  await assert.rejects(cache.get("index", () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await cache.get("index", () => Promise.resolve("ok")), "ok");
});
