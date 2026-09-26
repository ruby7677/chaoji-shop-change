// fetchWithTimeout：逾時／可傳入 signal 時的行為；以及 Worker 頂層 try/catch 在未預期例外時回傳
// 通用 503（不洩漏內部錯誤訊息），同時仍帶安全 header。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

test("fetchWithTimeout aborts a fetch that never resolves once the timeout elapses", async () => {
  const { fetchWithTimeout } = await loadSourceModule("http.ts");
  // The real global fetch would reject once its AbortSignal fires; a fake fetch
  // that ignores the signal would hang the test, so it must react to abort too.
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
  restoreFetch = () => { globalThis.fetch = original; };
  // Node's AbortSignal.timeout() abort event does not play well with node:test's
  // pending-promise tracking when awaited directly (a Node runtime quirk, not a
  // bug in fetchWithTimeout) — so the rejection is observed through a flag set by
  // a `.catch()`, and the test waits on an unrelated plain timer instead of
  // awaiting the timeout-derived promise itself.
  let rejected = false;
  let rejectedWith = null;
  fetchWithTimeout("https://upstream.test/x", {}, 20).catch((error) => { rejected = true; rejectedWith = error; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(rejected, true, "the call rejects once the 20ms timeout elapses instead of hanging");
  assert.equal(rejectedWith?.name, "AbortError");
});

test("fetchWithTimeout passes through a normal response", async () => {
  const { fetchWithTimeout } = await loadSourceModule("http.ts");
  restoreFetch = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const response = await fetchWithTimeout("https://upstream.test/x", {}, 5000);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("fetchWithTimeout combines a caller-supplied signal with the timeout signal", async () => {
  const { fetchWithTimeout } = await loadSourceModule("http.ts");
  const controller = new AbortController();
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
  restoreFetch = () => { globalThis.fetch = original; };
  const pending = fetchWithTimeout("https://upstream.test/x", { signal: controller.signal }, 5000);
  controller.abort();
  await assert.rejects(() => pending);
});

test("an uncaught upstream failure returns a generic 503 with security headers instead of leaking the error", async () => {
  const worker = await loadWorker();
  restoreFetch = stubFetch(() => { throw new Error("network is down"); });
  const response = await worker.fetch(new Request("https://shop.test/api/cart", { headers: { Authorization: "Bearer member-token" } }), baseEnv, ctx());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, { error: "服務暫時無法使用，請稍後再試" });
  assert.match(response.headers.get("Content-Security-Policy") || "", /default-src 'self'/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
