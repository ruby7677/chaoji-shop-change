// 結帳「套用」優惠碼：會員 JWT 呼叫唯讀試算 RPC、輸入驗證與資料庫錯誤轉為中文訊息。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const MEMBER_ID = "00000000-0000-4000-8000-0000000000d1";
const LINE_ID = "U" + "f".repeat(32);
const VARIANT_ID = "dddddddd-0000-4000-8000-0000000000d2";
const MEMBER_TOKEN = "Bearer member-access-token";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeSupabase(rpcResponse) {
  const calls = [];
  restoreFetch = stubFetch((url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/rpc/preview_checkout_coupon") {
      calls.push({ auth: new Headers(init.headers).get("Authorization"), body });
      return rpcResponse();
    }
    throw new Error(`unexpected request ${url}`);
  });
  return calls;
}

const preview = (body, headers = { Authorization: MEMBER_TOKEN }) => worker.fetch(new Request("https://shop.test/api/checkout/coupon-preview", {
  method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body)
}), baseEnv, ctx());

test("a valid code is previewed with the member's own token and returns the discount", async () => {
  const coupon = { code: "SAVE100", name: "折百券", discount_amount: 100, combinable_with_points: true };
  const calls = fakeSupabase(() => jsonResponse(coupon));
  const response = await preview({ items: [{ variant_id: VARIANT_ID, quantity: 2 }], coupon_code: " save100 " });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { coupon });
  assert.equal(calls[0].auth, MEMBER_TOKEN, "the preview runs under the member JWT, not the service role");
  assert.deepEqual(calls[0].body, { p_items: [{ variant_id: VARIANT_ID, quantity: 2 }], p_coupon_code: "save100" });
});

test("a rejected code returns the same message as order creation", async () => {
  fakeSupabase(() => jsonResponse({ message: "COUPON_EXPIRED" }, 400));
  const response = await preview({ items: [{ variant_id: VARIANT_ID, quantity: 1 }], coupon_code: "OLD" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "優惠券已失效或尚未開始");
});

test("an empty code or malformed items never reach the database", async () => {
  const calls = fakeSupabase(() => jsonResponse({}));
  assert.equal((await preview({ items: [{ variant_id: VARIANT_ID, quantity: 1 }], coupon_code: "  " })).status, 400);
  assert.equal((await preview({ items: [{ variant_id: "x", quantity: 1 }], coupon_code: "A" })).status, 400);
  assert.equal((await preview({ items: [{ variant_id: VARIANT_ID, quantity: 0 }], coupon_code: "A" })).status, 400);
  assert.equal((await preview({ items: [], coupon_code: "A" })).status, 400);
  assert.equal(calls.length, 0);
});

test("anonymous requests are rejected", async () => {
  const calls = fakeSupabase(() => jsonResponse({}));
  const response = await preview({ items: [{ variant_id: VARIANT_ID, quantity: 1 }], coupon_code: "A" }, {});
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});
