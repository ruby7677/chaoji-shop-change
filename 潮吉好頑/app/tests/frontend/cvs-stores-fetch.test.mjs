// 後台抓取 7-11 門市的流程（public/cvs-stores-fetch.js）：逐縣市依 next_offset 接續，抓齊的縣市放 byCity、整理成 6 欄 CSV；
// 任何縣市或鄉鎮失敗都列在 failed（呼叫端據此擋下發佈），暫時錯誤（網路、5xx、429）會等待後重試，登入失效則整趟停下。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFetchedCsv, fetchOfficialStores } from "../../public/cvs-stores-fetch.js";
import { CITY_SLUGS, parseCsv, planStoreUpload } from "../../public/cvs-stores-data.js";

const CITIES = Object.keys(CITY_SLUGS);
const codeOf = (city, n) => String(100000 + CITIES.indexOf(city) * 100 + n);
const noWait = async () => {};
const TOWNS = ["甲區", "乙區", "丙區", "丁區", "戊區", "己區", "庚區"];
const BATCH = 5;

/** 每個縣市 7 個鄉鎮、每鄉鎮 1 間；分兩批（5＋2）回應。statusFor(city, 第幾次呼叫) 回傳非 0 時丟出該狀態的錯誤 */
function fakeServer({ failTowns = {}, failCities = new Set(), statusFor = () => 0 } = {}) {
  const calls = [];
  const request = async ({ city, offset }) => {
    calls.push([city, offset]);
    const status = statusFor(city, calls.length);
    if (status === -1) throw new TypeError("Failed to fetch");
    if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
    if (failCities.has(city)) throw Object.assign(new Error("縣市不正確"), { status: 400 });
    const towns = TOWNS.slice(offset, offset + BATCH);
    const failed = towns.filter((town) => failTowns[city]?.includes(town));
    const rows = towns.filter((town) => !failed.includes(town)).map((town) => [town, codeOf(city, TOWNS.indexOf(town)), `${town}店`, `${city}${town}測試路1號`]);
    return { city, towns_total: TOWNS.length, next_offset: offset + BATCH < TOWNS.length ? offset + BATCH : null, rows, failed };
  };
  return { request, calls };
}

test("walks every city in batches and produces an uploadable CSV", async () => {
  const { request, calls } = fakeServer();
  const progress = [];
  const result = await fetchOfficialStores(request, { wait: noWait, interval: 0, onProgress: (p) => progress.push(p) });
  assert.equal(calls.length, CITIES.length * 2);
  assert.deepEqual(calls.slice(0, 2), [["台北市", 0], ["台北市", 5]]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual([...result.byCity.keys()], CITIES);
  const { rows, csv } = buildFetchedCsv(result.byCity);
  assert.equal(rows.length, CITIES.length * TOWNS.length);
  assert.deepEqual(rows.find((row) => row[2] === codeOf("台北市", 0)), ["台北市", "甲區", codeOf("台北市", 0), "測試路", "甲區店", "台北市甲區測試路1號"]);
  assert.deepEqual(parseCsv(csv), rows);
  assert.equal(planStoreUpload(csv, {}).blockers.length, 0, "the generated CSV passes the existing upload checks");
  assert.equal(progress.at(-1).city, CITIES.at(-1));
});

test("failed towns and cities are reported with the city, and those cities are left out of byCity", async () => {
  const { request, calls } = fakeServer({ failTowns: { 新北市: ["己區"] }, failCities: new Set(["金門縣"]) });
  const result = await fetchOfficialStores(request, { wait: noWait, interval: 0 });
  assert.deepEqual(result.failed.map(({ city, town }) => [city, town]), [["新北市", "己區"], ["金門縣", ""]]);
  assert.ok(result.failed.every(({ reason }) => reason));
  assert.ok(!result.byCity.has("新北市") && !result.byCity.has("金門縣"));
  assert.ok(result.byCity.has("台北市"));
  assert.ok(calls.some(([city]) => city === "連江縣"), "keeps going after a failed city");
});

test("only the requested cities are fetched when retrying failed ones", async () => {
  const { request, calls } = fakeServer();
  const result = await fetchOfficialStores(request, { cities: ["高雄市"], wait: noWait, interval: 0 });
  assert.deepEqual([...new Set(calls.map(([city]) => city))], ["高雄市"]);
  assert.deepEqual([...result.byCity.keys()], ["高雄市"]);
});

test("an expired login stops the whole run", async () => {
  const { request, calls } = fakeServer({ statusFor: (city) => (city === "新北市" ? 401 : 0) });
  await assert.rejects(fetchOfficialStores(request, { wait: noWait, interval: 0 }), (error) => error.status === 401);
  assert.ok(!calls.some(([city]) => city === "桃園市"));
});

test("a rate-limited call waits and retries instead of failing the city", async () => {
  const waits = [];
  const { request } = fakeServer({ statusFor: (city, n) => (n === 2 ? 429 : 0) });
  const result = await fetchOfficialStores(request, { wait: async (ms) => { waits.push(ms); }, interval: 0 });
  assert.deepEqual(result.failed, []);
  assert.ok(waits.some((ms) => ms >= 10_000));
});

test("a network drop or 5xx near the end is retried instead of failing the city", async () => {
  const total = CITIES.length * 2;
  const { request } = fakeServer({ statusFor: (city, n) => (n === total - 3 ? -1 : n === total - 1 ? 502 : 0) });
  const result = await fetchOfficialStores(request, { wait: noWait, interval: 0 });
  assert.deepEqual(result.failed, []);
  assert.equal(result.byCity.size, CITIES.length);
});

test("a call that keeps failing marks only that city as failed", async () => {
  const { request } = fakeServer({ statusFor: (city) => (city === "高雄市" ? 503 : 0) });
  const result = await fetchOfficialStores(request, { wait: noWait, interval: 0 });
  assert.deepEqual(result.failed.map(({ city }) => city), ["高雄市"]);
  assert.equal(result.byCity.size, CITIES.length - 1);
});

test("calls are spaced to stay under the admin API rate limit", async () => {
  const waits = [];
  const { request } = fakeServer();
  await fetchOfficialStores(request, { wait: async (ms) => { waits.push(ms); }, interval: 1100 });
  assert.ok(waits.length >= CITIES.length * 2 - 1);
  assert.ok(waits.every((ms) => ms > 0 && ms <= 1100));
});

test("the panel offers the fetch button, a download only for fetched results, and escapes failed names", async () => {
  const { uploadFormHtml, previewHtml, fetchFailedHtml } = await import("../../public/admin-cvs-stores-view.js");
  assert.match(uploadFormHtml(), /data-cvs-fetch/);
  const plan = planStoreUpload(CITIES.map((city, i) => `${city},甲區,${100000 + i},路,店${i},地址`).join("\n"), {});
  assert.doesNotMatch(previewHtml(plan, "a.csv"), /data-cvs-download/);
  assert.match(previewHtml(plan, "官方網站", { downloadable: true }), /data-cvs-download/);
  const failed = fetchFailedHtml([{ city: "台北市", town: "<img>", reason: "官方網站查詢失敗" }, { city: "高雄市", town: "", reason: "連線失敗" }]);
  assert.match(failed, /&lt;img&gt;/);
  assert.match(failed, /data-cvs-fetch-failed/);
  assert.match(failed, /重抓這 2 個縣市/);
  assert.doesNotMatch(failed, /data-cvs-publish/);
});
