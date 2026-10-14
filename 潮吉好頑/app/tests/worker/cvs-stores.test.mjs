// 後台上傳 7-11 門市：逐縣市暫存、發佈（縣市齊全、縮水保護、指標最後寫）、回復、清理舊版，
// 以及公開讀取路由（R2 版本優先、無版本時回到靜態檔、SPA fallback 不當成門市資料）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, fakeR2, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";
import { CITY_SLUGS } from "../../public/cvs-stores-data.js";

const worker = await loadWorker();
const { CVS_CITY_SLUGS } = await loadSourceModule("cvs-stores.ts");
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);
const V1 = "20261001000000-aaaaaa";
const POINTER = "cvs-stores/current.json";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function asAdmin() {
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    throw new Error(`unexpected request: ${url}`);
  });
}

const call = (env, method, path, body) => worker.fetch(new Request(`https://shop.test${path}`, {
  method,
  headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body)
}), env, ctx());

const store = (n, name = `測試${n}門市`) => [String(100000 + n), name, `測試路${n}號`];
/** 每個縣市 perCity 間門市、兩個鄉鎮區 */
const cityData = (perCity, offset = 0) => {
  const half = Math.ceil(perCity / 2);
  const stores = Array.from({ length: perCity }, (_, i) => store(offset + i + 1));
  return { 甲區: stores.slice(0, half), 乙區: stores.slice(half) };
};
async function stageAll(env, version, perCity = 4) {
  for (const [index, city] of Object.keys(CITY_SLUGS).entries()) {
    const response = await call(env, "PUT", "/api/admin/cvs-stores/stage", { version, city, data: cityData(perCity, index * 100) });
    assert.equal(response.status, 200, `${city}: ${await response.clone().text()}`);
  }
}
const publish = (env, version) => call(env, "POST", "/api/admin/cvs-stores/publish", { version });
const newEnv = () => ({ ...baseEnv, PRODUCT_IMAGES: fakeR2() });

test("the Worker's city whitelist matches the shared module's", () => {
  assert.deepEqual(CVS_CITY_SLUGS, CITY_SLUGS);
});

test("staging one city stores it with server-computed count and districts", async () => {
  asAdmin();
  const env = newEnv();
  const response = await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: V1, city: "台北市", data: cityData(5), count: 9999 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: V1, city: "台北市", count: 5 });
  const head = await env.PRODUCT_IMAGES.head(`cvs-stores/${V1}/taipei.json`);
  assert.equal(head.customMetadata.count, "5");
  assert.deepEqual(JSON.parse(head.customMetadata.districts), ["甲區", "乙區"]);
  assert.equal(await env.PRODUCT_IMAGES.head(POINTER), null, "staging never touches the live pointer");
});

const rejected = [
  ["a store code that is not 6 digits", { 甲區: [["12345", "好門市", "a"]] }],
  ["a store name over 40 characters", { 甲區: [["123456", "長".repeat(41), "a"]] }],
  ["an empty store name", { 甲區: [["123456", "  ", "a"]] }],
  ["a district name over 10 characters", { ["區".repeat(11)]: [["123456", "好門市", "a"]] }],
  ["a duplicate store code", { 甲區: [["123456", "好門市", "a"]], 乙區: [["123456", "壞門市", "b"]] }],
  ["control characters in an address", { 甲區: [["123456", "好門市", "a\u0000b"]] }],
  ["a row with the wrong number of fields", { 甲區: [["123456", "好門市"]] }],
  ["a district without stores", { 甲區: [] }],
  ["an empty city", {}],
  ["an array instead of an object", []]
];
for (const [label, data] of rejected) {
  test(`staging rejects ${label} without writing anything`, async () => {
    asAdmin();
    const env = newEnv();
    const response = await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: V1, city: "台北市", data });
    assert.equal(response.status, 400);
    assert.equal(env.PRODUCT_IMAGES.objects.size, 0);
  });
}

test("staging rejects an unknown city, a bad version and an already published version", async () => {
  asAdmin();
  const env = newEnv();
  assert.equal((await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: V1, city: "火星市", data: cityData(2) })).status, 400);
  assert.equal((await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: V1, city: "constructor", data: cityData(2) })).status, 400);
  assert.equal((await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: "../x", city: "台北市", data: cityData(2) })).status, 400);
  assert.equal(env.PRODUCT_IMAGES.objects.size, 0);
  await stageAll(env, V1);
  assert.equal((await publish(env, V1)).status, 200);
  const again = await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: V1, city: "台北市", data: cityData(2) });
  assert.equal(again.status, 409, "a published version is immutable");
});

test("publishing needs every city; the pointer is written last from server-side counts", async () => {
  asAdmin();
  const env = newEnv();
  for (const city of Object.keys(CITY_SLUGS).slice(1)) await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: V1, city, data: cityData(3) });
  const missing = await publish(env, V1);
  assert.equal(missing.status, 409);
  assert.match((await missing.json()).error, /台北市/);
  assert.equal(await env.PRODUCT_IMAGES.head(POINTER), null);

  await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: V1, city: "台北市", data: cityData(3) });
  env.PRODUCT_IMAGES.events.length = 0;
  const response = await publish(env, V1);
  assert.deepEqual(await response.json(), { ok: true, version: V1, total: 66 });
  const writes = env.PRODUCT_IMAGES.events.filter(([kind]) => kind === "put").map(([, key]) => key);
  assert.deepEqual(writes, [`cvs-stores/${V1}/index.json`, `cvs-stores/${V1}/manifest.json`, POINTER], "index and manifest first, pointer last");
  const index = await (await env.PRODUCT_IMAGES.get(`cvs-stores/${V1}/index.json`)).json();
  assert.equal(index.length, 22);
  assert.deepEqual(index[0], ["台北市", "taipei", ["甲區", "乙區"]]);
  const pointer = await (await env.PRODUCT_IMAGES.get(POINTER)).json();
  assert.equal(pointer.version, V1);
  assert.equal(pointer.total, 66);
  assert.equal(pointer.publishedBy, ADMIN_ID);
});

test("a new version that shrinks by more than 5% is refused and the old one stays live", async () => {
  asAdmin();
  const env = newEnv();
  await stageAll(env, V1, 10);
  assert.equal((await publish(env, V1)).status, 200);
  const V2 = "20261002000000-bbbbbb";
  await stageAll(env, V2, 9);
  const refused = await publish(env, V2);
  assert.equal(refused.status, 409);
  assert.equal((await (await env.PRODUCT_IMAGES.get(POINTER)).json()).version, V1);
  assert.equal(await env.PRODUCT_IMAGES.head(`cvs-stores/${V2}/manifest.json`), null);
  const V3 = "20261003000000-cccccc";
  await stageAll(env, V3, 11);
  assert.equal((await publish(env, V3)).status, 200, "growing is fine");
});

test("publishing twice is idempotent and old versions beyond the last five are pruned", async () => {
  asAdmin();
  const env = newEnv();
  const versions = Array.from({ length: 7 }, (_, i) => `2026100${i + 1}000000-00000${i}`);
  for (const version of versions) {
    await stageAll(env, version, 2);
    assert.equal((await publish(env, version)).status, 200);
  }
  assert.equal((await publish(env, versions[6])).status, 200);
  const manifests = [...env.PRODUCT_IMAGES.objects.keys()].filter((key) => key.endsWith("/manifest.json"));
  assert.deepEqual(manifests, versions.slice(2).map((version) => `cvs-stores/${version}/manifest.json`));
  assert.ok(![...env.PRODUCT_IMAGES.objects.keys()].some((key) => key.includes(versions[0])), "the oldest version is fully gone");
  const deletes = env.PRODUCT_IMAGES.events.filter(([kind]) => kind === "r2-delete");
  assert.ok(deletes.every(([, keys]) => Array.isArray(keys) && keys.length > 1), "old keys are removed with one batched delete");
});

test("an abandoned staging older than the published version is cleaned up, a newer one is kept", async () => {
  asAdmin();
  const env = newEnv();
  const OLD = "20260901000000-dead01";
  const NEWER = "20261209000000-beef02";
  await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: OLD, city: "台北市", data: cityData(2) });
  await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: NEWER, city: "台北市", data: cityData(2) });
  await stageAll(env, V1, 2);
  await publish(env, V1);
  const keys = [...env.PRODUCT_IMAGES.objects.keys()];
  assert.ok(!keys.some((key) => key.includes(OLD)));
  assert.ok(keys.some((key) => key.includes(NEWER)));
});

test("rollback points at a kept version or back to the built-in files", async () => {
  asAdmin();
  const env = newEnv();
  const V2 = "20261002000000-bbbbbb";
  await stageAll(env, V1, 3);
  await publish(env, V1);
  await stageAll(env, V2, 3);
  await publish(env, V2);
  const back = await call(env, "POST", "/api/admin/cvs-stores/rollback", { version: V1 });
  assert.deepEqual(await back.json(), { ok: true, version: V1, total: 66 });
  assert.equal((await (await env.PRODUCT_IMAGES.get(POINTER)).json()).version, V1);
  assert.equal((await call(env, "POST", "/api/admin/cvs-stores/rollback", { version: "20250101000000-ffffff" })).status, 404);
  assert.equal((await call(env, "POST", "/api/admin/cvs-stores/rollback", { version: "../../etc" })).status, 400);
  assert.equal((await (await env.PRODUCT_IMAGES.get(POINTER)).json()).version, V1, "failed rollbacks leave the pointer alone");
  const baseline = await call(env, "POST", "/api/admin/cvs-stores/rollback", { version: "baseline" });
  assert.equal(baseline.status, 200);
  assert.equal(await env.PRODUCT_IMAGES.head(POINTER), null);
});

test("the admin list shows the current version, history and unfinished staging", async () => {
  asAdmin();
  const env = newEnv();
  await stageAll(env, V1, 2);
  await publish(env, V1);
  await call(env, "PUT", "/api/admin/cvs-stores/stage", { version: "20261005000000-abcdef", city: "台北市", data: cityData(2) });
  const body = await (await call(env, "GET", "/api/admin/cvs-stores")).json();
  assert.equal(body.current.version, V1);
  assert.deepEqual(body.published.map((v) => [v.version, v.total, v.is_current]), [[V1, 44, true]]);
  assert.deepEqual(body.staged.map((v) => [v.version, v.cities]), [["20261005000000-abcdef", ["台北市"]]]);
  assert.equal(body.city_count, 22);
});

test("without the R2 binding the admin routes answer 503", async () => {
  asAdmin();
  const response = await call(baseEnv, "GET", "/api/admin/cvs-stores");
  assert.equal(response.status, 503);
});

// ---- 公開讀取 ----

const assetJson = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const readEnv = (r2, assets) => ({ ...baseEnv, ...(r2 ? { PRODUCT_IMAGES: r2 } : {}), ASSETS: { fetch: assets } });
const read = (env, path, method = "GET") => worker.fetch(new Request(`https://shop.test${path}`, { method }), env, ctx());

test("without a published R2 version the static file is served as JSON with a short cache", async () => {
  const env = readEnv(fakeR2(), async () => assetJson([["台北市", "taipei", ["中正區"]]]));
  const response = await read(env, "/cvs-stores/index.json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [["台北市", "taipei", ["中正區"]]]);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.ok(response.headers.get("Content-Security-Policy"));
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("a published R2 version wins over the static file, for the index and each city", async () => {
  asAdmin();
  const r2 = fakeR2();
  const env = { ...baseEnv, PRODUCT_IMAGES: r2, ASSETS: { fetch: async () => assetJson({ static: true }) } };
  await stageAll(env, V1, 2);
  await publish(env, V1);
  restoreFetch();
  const city = await read(env, "/cvs-stores/taipei.json");
  assert.equal(city.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(await city.json()), ["甲區", "乙區"]);
  assert.equal((await (await read(env, "/cvs-stores/index.json")).json()).length, 22);
  assert.equal((await read(env, "/cvs-stores/taipei.json", "HEAD")).status, 200);
});

test("a city missing from the static files is a JSON 404, not the single-page app", async () => {
  const env = readEnv(fakeR2(), async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));
  const response = await read(env, "/cvs-stores/kinmen.json");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Content-Type")?.includes("json"), true);
});

test("only index.json and known city files are served", async () => {
  let assetCalls = 0;
  const env = readEnv(fakeR2(), async () => { assetCalls += 1; return assetJson({}); });
  for (const path of ["/cvs-stores/unknown.json", "/cvs-stores/current.json", "/cvs-stores/a.b.json", "/cvs-stores/x/taipei.json", "/cvs-stores/taipei.html", "/cvs-stores/"]) {
    assert.equal((await read(env, path)).status, 404, path);
  }
  assert.equal(assetCalls, 0);
});

test("a failing or missing R2 bucket falls back to the static file", async () => {
  const broken = { get: async () => { throw new Error("r2 down"); } };
  const logged = console.error;
  console.error = () => {};
  try {
    for (const env of [readEnv(broken, async () => assetJson({ ok: 1 })), readEnv(null, async () => assetJson({ ok: 1 }))]) {
      const response = await read(env, "/cvs-stores/taipei.json");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: 1 });
    }
  } finally { console.error = logged; }
});
