// 後台抓取門市產生的 CSV（public/cvs-road-name.js）：路名與整理規則要和 scripts/fetch_711_stores.py 相同，
// 案例沿用 tests/scripts/test_fetch_711_stores.py；產生的 CSV 必須能被上傳流程的 parseCsv 原樣讀回。
import { test } from "node:test";
import assert from "node:assert/strict";
import { roadName, toCsv, toFinalRows } from "../../public/cvs-road-name.js";
import { parseCsv } from "../../public/cvs-stores-data.js";

test("strips city, district and neighbourhood", () => {
  assert.equal(roadName("台北市中山區民權東路二段96號98號1樓"), "民權東路");
  assert.equal(roadName("新北市板橋區21鄰復興路3號"), "復興路");
});

test("a district name starting with a road marker", () => {
  assert.equal(roadName("高雄市路竹區路科十路11號1樓"), "路科十路");
});

test("the first road wins when the address names two", () => {
  assert.equal(roadName("台北市中山區中原街37號.吉林路168巷22號"), "中原街");
  assert.equal(roadName("桃園市八德區中興街42號興仁路46號48號"), "中興街");
});

test("an admin unit before the road is dropped but road names containing it are kept", () => {
  assert.equal(roadName("新北市三峽區鳶山里21鄰復興路447號"), "復興路");
  assert.equal(roadName("南投縣仁愛鄉大同村定遠新村路18-1號"), "定遠新村路");
  assert.equal(roadName("台中市豐原區南村里豐東路412號"), "豐東路");
  assert.equal(roadName("屏東縣車城鄉新街村保新路25之2號"), "保新路");
  assert.equal(roadName("台中市大里區大里路97號1樓"), "大里路");
  assert.equal(roadName("台中市南區美村路二段188號"), "美村路");
});

test("village and place name fallbacks", () => {
  assert.equal(roadName("南投縣仁愛鄉定遠新村26之1號"), "定遠新村");
  assert.equal(roadName("苗栗縣大湖鄉下員坑39之1號"), "下員坑");
  assert.equal(roadName("台北市中山區"), "");
});

test("six columns sorted by city order, without header rows or duplicate codes", () => {
  const raw = [
    ["縣市", "地區", "門市編號", "門市名稱", "門市地址"],
    ["高雄市", "苓雅區", "000002   ", "乙", "高雄市苓雅區四維路1號"],
    ["台北市", "中山區", "000001   ", "甲", "台北市中山區民權東路二段96號"],
    ["台北市", "中山區", "000001   ", "甲", "台北市中山區民權東路二段96號"]
  ];
  assert.deepEqual(toFinalRows(raw), [
    ["台北市", "中山區", "000001", "民權東路", "甲", "台北市中山區民權東路二段96號"],
    ["高雄市", "苓雅區", "000002", "四維路", "乙", "高雄市苓雅區四維路1號"]
  ]);
});

test("the generated CSV reads back unchanged, including commas and quotes in a field", () => {
  const rows = [
    ["台北市", "中山區", "128069", "林森北路", "歡唱", "台北市中山區林森北路310巷10號中山北路二段59巷55.55-1~4.57.59"],
    ["台北市", "中山區", "130394", "吉林路", "吉林", '台北市中山區吉林路209號1樓,2樓"B棟"']
  ];
  const csv = toCsv(rows);
  assert.ok(csv.endsWith("\r\n"));
  assert.deepEqual(parseCsv(csv), rows);
});
