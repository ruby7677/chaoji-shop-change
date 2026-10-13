// 雲端購物車同步重試：失敗後依退避重送、恢復連線或回到頁面立即重送、成功後清除等待。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCartSyncRetry } from "../../public/cart-sync-retry.js";

function fakeTarget() {
  const listeners = new Map();
  const timers = new Map();
  let nextId = 1;
  const on = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  return {
    timers,
    addEventListener: on,
    emit: (type) => (listeners.get(type) ?? []).forEach((fn) => fn()),
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    runTimers() { const due = [...timers.values()]; timers.clear(); due.forEach(({ fn }) => fn()); }
  };
}

function setup() {
  const target = fakeTarget();
  const doc = { ...fakeTarget(), visibilityState: "visible" };
  let runs = 0;
  const retry = createCartSyncRetry({ run: () => { runs += 1; }, delays: [10, 20, 40], target, doc });
  return { target, doc, retry, runs: () => runs };
}

test("a failed sync is retried after the first backoff delay", () => {
  const { target, retry, runs } = setup();
  retry.schedule();
  assert.deepEqual([...target.timers.values()].map((t) => t.delay), [10]);
  target.runTimers();
  assert.equal(runs(), 1);
  assert.equal(retry.pending, false);
});

test("repeated failures back off up to the last delay", () => {
  const { target, retry } = setup();
  const delays = [];
  for (let n = 0; n < 5; n += 1) {
    retry.schedule();
    delays.push([...target.timers.values()][0].delay);
    target.runTimers();
  }
  assert.deepEqual(delays, [10, 20, 40, 40, 40]);
});

test("coming back online retries at once and cancels the timer", () => {
  const { target, retry, runs } = setup();
  retry.schedule();
  target.emit("online");
  assert.equal(runs(), 1);
  assert.equal(target.timers.size, 0);
});

test("returning to the page retries, a hidden page does not", () => {
  const { doc, retry, runs } = setup();
  retry.schedule();
  doc.visibilityState = "hidden";
  doc.emit("visibilitychange");
  assert.equal(runs(), 0);
  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  assert.equal(runs(), 1);
});

test("online without a failed sync does nothing", () => {
  const { target, runs } = setup();
  target.emit("online");
  assert.equal(runs(), 0);
});

test("reset cancels the wait and restarts the backoff", () => {
  const { target, retry, runs } = setup();
  retry.schedule();
  retry.schedule();
  retry.reset();
  assert.equal(target.timers.size, 0);
  target.emit("online");
  assert.equal(runs(), 0);
  retry.schedule();
  assert.equal([...target.timers.values()][0].delay, 10);
});
