// 後台上傳 7-11 門市 CSV：解析／比對（public/cvs-stores-data.js）與預覽畫面（admin-cvs-stores-view.js）。
// 不執行 scripts/build-cvs-stores.mjs 的 main（它會刪除 public/cvs-stores/），只測匯出的純函式。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CITY_SLUGS, buildStoreFiles, diffCityData, groupStores, newVersionId, parseCsv, planStoreUpload, shrinkRatio } from "../../public/cvs-stores-data.js";
import { parseCsv as scriptParseCsv, groupStores as scriptGroupStores } from "../../scripts/build-cvs-stores.mjs";
import { currentCardHtml, previewHtml } from "../../public/admin-cvs-stores-view.js";

const line = (city, district, code, name, address = "某路1號") => `${city},${district},${code},路,${name},${address}`;
/** 22 個縣市各 perCity 間門市的 CSV */
function fullCsv(perCity = 3, { skip = [] } = {}) {
  const rows = [];
  Object.keys(CITY_SLUGS).forEach((city, ci) => {
    if (skip.includes(city)) return;
    for (let i = 0; i < perCity; i += 1) rows.push(line(city, i % 2 ? "乙區" : "甲區", String(100000 + ci * 100 + i), `店${ci}-${i}`));
  });
  return rows.join("\n");
}
const filesOf = (csv) => buildStoreFiles(groupStores(parseCsv(csv))).files;

test("the build script keeps exporting the shared parser", () => {
  assert.equal(scriptParseCsv, parseCsv);
  assert.equal(scriptGroupStores, groupStores);
});

test("parseCsv handles quoted commas, BOM and blank lines", () => {
  assert.deepEqual(parseCsv('\uFEFFa,"b,c",d\n\n"e""f",g,h\r\n'), [["a", "b,c", "d"], ['e"f', "g", "h"]]);
});

test("groupStores skips invalid rows, appends 門市 and throws on over-long fields", () => {
  const cities = groupStores(parseCsv([line("台北市", "中正區", "123456", "好"), line("火星市", "甲區", "123457", "x"), line("台北市", "中正區", "12345", "短碼"), line("台北市", "", "123458", "缺區")].join("\n")));
  assert.deepEqual(cities.get("台北市").get("中正區"), [["123456", "好門市", "某路1號"]]);
  assert.equal(cities.has("火星市"), false);
  assert.throws(() => groupStores(parseCsv(line("台北市", "中正區", "123456", "長".repeat(41)))), /長度限制/);
});

test("diffCityData reports added, removed and changed stores", () => {
  const before = { 甲區: [["100001", "A門市", "路1"], ["100002", "B門市", "路2"]] };
  const after = { 甲區: [["100001", "A門市", "路1改"], ["100003", "C門市", "路3"]] };
  const diff = diffCityData(before, after);
  assert.deepEqual([diff.added.map((s) => s.code), diff.removed.map((s) => s.code), diff.changed.map((s) => s.code)], [["100003"], ["100002"], ["100001"]]);
  assert.deepEqual([diff.before, diff.after], [2, 2]);
  assert.deepEqual(diffCityData(null, after).added.length, 2);
});

test("shrinkRatio is 0 without a baseline and grows as stores disappear", () => {
  assert.equal(shrinkRatio(0, 10), 0);
  assert.equal(shrinkRatio(100, 120), 0);
  assert.equal(shrinkRatio(100, 90), 0.1);
});

test("a complete CSV with no change against the current list has no blockers or differences", () => {
  const csv = fullCsv();
  const plan = planStoreUpload(csv, filesOf(csv));
  assert.deepEqual([plan.total, plan.beforeTotal, plan.added, plan.removed, plan.changed, plan.blockers], [66, 66, 0, 0, 0, []]);
});

test("the preview blocks a CSV with missing cities, duplicate codes or a >5% drop", () => {
  const csv = fullCsv(20);
  const current = filesOf(csv);
  const missing = planStoreUpload(fullCsv(20, { skip: ["金門縣"] }), current);
  assert.match(missing.blockers.join(), /缺少縣市：金門縣/);
  const shrunk = planStoreUpload(fullCsv(18), current);
  assert.match(shrunk.blockers.join(), /超過 5% 上限/);
  const dup = planStoreUpload(`${fullCsv(3)}\n${line("台北市", "甲區", "100000", "重複")}`, {});
  assert.match(dup.blockers.join(), /店號重複/);
  assert.ok(planStoreUpload("", {}).blockers.length > 0);
  assert.equal(planStoreUpload(fullCsv(3), {}).blockers.length, 0, "no current list means nothing to shrink from");
});

test("rows that are not stores are counted as skipped but a header line is not", () => {
  const plan = planStoreUpload(`縣市,鄉鎮區,店號,路名,店名,地址\n${fullCsv(1)}\n台北市,甲區,abc,路,壞,地址`, {});
  assert.equal(plan.skipped, 1);
});

test("newVersionId sorts by time and matches the Worker's pattern", () => {
  const a = newVersionId(new Date("2026-10-15T01:02:03Z"), new Uint8Array([1, 2, 255]));
  const b = newVersionId(new Date("2026-10-15T01:02:04Z"), new Uint8Array([0, 0, 0]));
  assert.equal(a, "20261015010203-0102ff");
  assert.match(b, /^\d{14}-[0-9a-f]{6}$/);
  assert.ok(a < b);
});

test("the preview escapes uploaded store names and addresses", () => {
  const evil = '<img src=x onerror=alert(1)>';
  const csv = `${fullCsv(3)}\n${line("台北市", "甲區", "999999", evil, evil)}`;
  const html = previewHtml(planStoreUpload(csv, {}), `${evil}.csv`);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
  assert.match(previewHtml(planStoreUpload(fullCsv(20), filesOf(fullCsv(20))), "ok.csv"), /data-cvs-publish\s*>/);
  assert.match(previewHtml(planStoreUpload("", {}), "empty.csv"), /data-cvs-publish disabled/);
});

test("the current card shows built-in status, history and rollback buttons", () => {
  const time = (value) => `T:${value}`;
  assert.match(currentCardHtml({ current: null, published: [], staged: [] }, time), /內建檔案/);
  const html = currentCardHtml({
    current: { version: "v2", total: 7387, publishedAt: "p2", publishedBy: "12345678-aaaa" },
    published: [{ version: "v2", total: 7387, published_at: "p2", published_by: "12345678-aaaa", is_current: true }, { version: "v1", total: 7278, published_at: "p1", published_by: "x", is_current: false }],
    staged: [{ version: "v3", cities: [], uploaded_at: "u" }]
  }, time);
  assert.match(html, /使用中/);
  assert.match(html, /data-cvs-rollback="v1"/);
  assert.doesNotMatch(html, /data-cvs-rollback="v2"/);
  assert.match(html, /data-cvs-baseline/);
  assert.match(html, /1 份未完成/);
});

test("public/cvs-stores-data.js is runtime-neutral (no Node or DOM imports)", async () => {
  const source = await readFile(new URL("../../public/cvs-stores-data.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /node:|document\.|window\./);
});
