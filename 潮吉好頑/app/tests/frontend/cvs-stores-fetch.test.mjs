// 後台抓取 7-11 門市的流程（public/cvs-stores-fetch.js）：逐縣市依 next_offset 接續、整理成 6 欄 CSV；
// 任何縣市或鄉鎮失敗都列在 failed（呼叫端據此擋下發佈），登入失效則整趟停下，429 會等待後重試。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchOfficialStores } from "../../public/cvs-stores-fetch.js";
import { CITY_SLUGS } from "../../public/cvs-stores-data.js";
import { parseCsv, planStoreUpload } from "../../public/cvs-stores-data.js";

const CITIES = Object.keys(CITY_SLUGS);
const codeOf = (city, n) => String(100000 + CITIES.indexOf(city) * 100 + n);
const noWait = async () => {};
const TOWNS = ["甲區", "乙區", "丙區", "丁區", "戊區", "己區", "庚區"];

/** 每個縣市 7 個鄉鎮、每鄉鎮 1 間；分兩批（5＋2）回應 */
function fakeServer({ failTowns = {}, failCities = new Set(), statusFor = () => 0 } = {}) {
  const calls = [];
  const request = async ({ city, offset }) => {
    calls.push([city, offset]);
    const status = statusFor(city, calls.length);
    if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
    if (failCities.has(city)) throw Object.assign(new Error("無法取得鄉鎮清單"), { status: 502 });
    const towns = TOWNS.slice(offset, offset + 5);
    const failed = towns.filter((town) => failTowns[city]?.includes(town));
    const rows = towns.filter((town) => !failed.includes(town)).map((town) => [town, codeOf(city, TOWNS.indexOf(town)), `${town}店`, `${city}${town}測試路1號`]);
    return { city, towns_total: 7, next_offset: offset + 5 < 7 ? offset + 5 : null, rows, failed };
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
  assert.equal(result.rows.length, CITIES.length * 7);
  assert.deepEqual(result.rows.find((row) => row[2] === codeOf("台北市", 0)), ["台北市", "甲區", codeOf("台北市", 0), "測試路", "甲區店", "台北市甲區測試路1號"]);
  assert.deepEqual(parseCsv(result.csv), result.rows);
  assert.equal(planStoreUpload(result.csv, {}).blockers.length, 0, "the generated CSV passes the existing upload checks");
  assert.equal(progress.at(-1).city, CITIES.at(-1));
});

test("failed towns and cities are reported, and the others are still fetched", async () => {
  const { request, calls } = fakeServer({ failTowns: { 新北市: ["己區"] }, failCities: new Set(["金門縣"]) });
  const result = await fetchOfficialStores(request, { wait: noWait, interval: 0 });
  assert.deepEqual(result.failed, ["新北市己區", "金門縣"]);
  assert.ok(calls.some(([city]) => city === "連江縣"), "keeps going after a failed city");
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
  const plan = planStoreUpload(Object.keys(CITY_SLUGS).map((city, i) => `${city},甲區,${100000 + i},路,店${i},地址`).join("\n"), {});
  assert.doesNotMatch(previewHtml(plan, "a.csv"), /data-cvs-download/);
  assert.match(previewHtml(plan, "官方網站", { downloadable: true }), /data-cvs-download/);
  const failed = fetchFailedHtml(["台北市<img>"]);
  assert.match(failed, /&lt;img&gt;/);
  assert.doesNotMatch(failed, /data-cvs-publish/);
});
