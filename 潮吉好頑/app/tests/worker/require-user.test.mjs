// 會員授權（requireUser）：只有 Supabase 確定拒絕 token 才回 401；限流、5xx、逾時回 503，前端不會因此把會員登出。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, lineUser, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeUserLookup(outcome) {
  restoreFetch = stubFetch((url) => {
    if (url.pathname === "/auth/v1/user") {
      if (outcome === "timeout") throw new Error("network timeout");
      return outcome === 200 ? jsonResponse(lineUser("user-1")) : jsonResponse({ msg: "x" }, outcome);
    }
    return jsonResponse([]);
  });
}

const listOrders = () => worker.fetch(new Request("https://shop.test/api/orders", {
  headers: { Authorization: "Bearer member-access-token" }
}), baseEnv, ctx());

for (const outcome of [429, 500, 503, "timeout"]) {
  test(`a ${outcome} from the user lookup is reported as temporarily unavailable`, async () => {
    fakeUserLookup(outcome);
    const response = await listOrders();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "AUTH_UNAVAILABLE");
  });
}

for (const status of [401, 403]) {
  test(`a ${status} from the user lookup means the login has expired`, async () => {
    fakeUserLookup(status);
    assert.equal((await listOrders()).status, 401);
  });
}

test("a valid token reaches the route", async () => {
  fakeUserLookup(200);
  assert.equal((await listOrders()).status, 200);
});
