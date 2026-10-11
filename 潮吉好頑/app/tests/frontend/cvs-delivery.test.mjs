// 7-11 店到店運費：前台估算必須與資料庫 private.cvs_shipping_fee 相同，門市欄位驗證與 Worker 一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CVS_FREE_SHIPPING_THRESHOLD, CVS_SHIPPING_FEE, cvsFeeHint, cvsPickupStoreText, cvsShippingFee } from "../../public/cvs-delivery.js";
import { groupStores, parseCsv } from "../../scripts/build-cvs-stores.mjs";

test("前台運費常數與 migration 的 private.cvs_shipping_fee 一致", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/202610110001_cvs_delivery.sql", import.meta.url), "utf8");
  const match = sql.match(/>=\s*(\d+)\s*then\s*0\s*else\s*(\d+)\s*end/i);
  assert.ok(match, "找不到 cvs_shipping_fee 的金額規則");
  assert.deepEqual([Number(match[1]), Number(match[2])], [CVS_FREE_SHIPPING_THRESHOLD, CVS_SHIPPING_FEE]);
});

test("cvsShippingFee：未滿 6000 收 60，滿 6000 免運", () => {
  assert.deepEqual([cvsShippingFee(0), cvsShippingFee(5999), cvsShippingFee(6000), cvsShippingFee(12000)], [60, 60, 0, 0]);
});

test("cvsFeeHint：現貨提示免運差額，預購提示運費隨尾款", () => {
  assert.match(cvsFeeHint(5000, false), /再買 NT\$1,000 即可免運/);
  assert.match(cvsFeeHint(6000, false), /免運/);
  assert.match(cvsFeeHint(1000, true), /到貨後與尾款一併收取/);
});

test("cvsPickupStoreText：組合縣市、鄉鎮區、門市與店號；沒有門市時為空字串", () => {
  assert.equal(cvsPickupStoreText({ pickup_store_city: "台南市", pickup_store_district: "中西區", pickup_store_name: "民生門市", pickup_store_code: "123456" }), "台南市中西區 民生門市（123456）");
  assert.equal(cvsPickupStoreText({}), "");
});

test("門市 CSV：引號內逗號不切欄，店名補「門市」，無效店號略過", () => {
  const rows = parseCsv('﻿彰化縣,和美鎮,267209,美寮路,糖鑫,"彰化縣和美鎮美寮路一段483,485號"\n台南市,中西區,12345,民生路,壞資料,地址\n');
  const stores = groupStores(rows);
  assert.deepEqual(stores.get("彰化縣").get("和美鎮"), [["267209", "糖鑫門市", "彰化縣和美鎮美寮路一段483,485號"]]);
  assert.equal(stores.has("台南市"), false);
});

test("產生的門市資料：每個縣市檔都存在，名稱符合資料庫長度與店號格式", async () => {
  const index = JSON.parse(await readFile(new URL("../../public/cvs-stores/index.json", import.meta.url), "utf8"));
  assert.ok(index.length >= 19);
  for (const [city, slug, districts] of index) {
    const data = JSON.parse(await readFile(new URL(`../../public/cvs-stores/${slug}.json`, import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(data), districts, city);
    for (const district of districts) {
      assert.ok(city.length <= 10 && district.length <= 10, district);
      assert.ok(data[district].every(([code, name]) => /^\d{6}$/.test(code) && name.length <= 40), district);
    }
  }
});
