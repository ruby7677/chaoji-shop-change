// 後台抓取 7-11 門市（src/cvs-stores-fetch.ts）：只有管理員、只接受白名單縣市與 offset，鄉鎮由伺服器自己向官方查，
// 每次最多 EMAP_TOWNS_PER_REQUEST 個鄉鎮；查不到的鄉鎮列在 failed（後台據此擋下發佈）。官方回應以 2026-10 實際抓到的 XML 為樣本。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const fetchModule = await loadSourceModule("cvs-stores-fetch.ts");
const { CVS_CITY_SLUGS } = await loadSourceModule("cvs-stores.ts");
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);

const HEAD = '<?xml version="1.0" encoding="utf-8"?><iMapSDKOutput><MessageID>00000</MessageID><Status>連線成功</Status>';
const townsXml = (names) => `${HEAD}${names.map((name, i) => `<GeoPosition><TownID>${String(i + 1).padStart(2, "0")}</TownID><TownName>${name}</TownName><X>1</X><Y>2</Y></GeoPosition>`).join("")}</iMapSDKOutput>`;
// 與官方回應相同：店號後面補空白、店名可能含實體字元
const storesXml = (stores) => `${HEAD}${stores.map(([code, name, address]) => `<GeoPosition><POIID>${code}              </POIID><POIName>${name}</POIName><X>1</X><Y>2</Y><Address>${address}</Address><OP_TIME>06:00 ~ 23:00</OP_TIME></GeoPosition>`).join("")}</iMapSDKOutput>`;

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function stubEmap({ admin = true, towns = ["中正區", "大同區"], fail = new Set(), townsDown = false } = {}) {
  const seen = [];
  restoreFetch = stubFetch(async (url, init) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: admin, line_user_id: LINE_ID }]);
    if (url.hostname === "emap.pcsc.com.tw") {
      const params = new URLSearchParams(init.body);
      seen.push(Object.fromEntries(params));
      assert.equal(init.headers.Origin, "https://emap.pcsc.com.tw");
      if (params.get("commandid") === "GetTown") return townsDown ? new Response("busy", { status: 503 }) : new Response(townsXml(towns));
      const town = params.get("town");
      if (fail.has(town)) return new Response("error", { status: 500 });
      return new Response(storesXml([[`1${String(towns.indexOf(town)).padStart(5, "0")}`, `${town}門市&amp;店`, `台北市${town}測試路1號`]]));
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return seen;
}

const call = (body) => worker.fetch(new Request("https://shop.test/api/admin/cvs-stores/fetch", {
  method: "POST",
  headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
  body: JSON.stringify(body)
}), baseEnv, ctx());

test("returns one batch of towns with trimmed codes and decoded names, and where to continue", async () => {
  const towns = ["一區", "二區", "三區", "四區", "五區", "六區"];
  const batch = fetchModule.EMAP_TOWNS_PER_REQUEST;
  const seen = stubEmap({ towns });
  const response = await call({ city: "台北市", offset: 0 });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.towns_total, 6);
  assert.equal(result.next_offset, batch);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.rows[0], ["一區", "100000", "一區門市&店", "台北市一區測試路1號"]);
  assert.deepEqual(seen.filter((p) => p.commandid === "SearchStore").map((p) => p.town), towns.slice(0, batch));
  assert.equal(seen[0].cityid, "01");
});

test("the last batch reports no next offset", async () => {
  const towns = ["一區", "二區", "三區", "四區", "五區", "六區"];
  stubEmap({ towns });
  const offset = towns.length - 1;
  const result = await (await call({ city: "台北市", offset })).json();
  assert.equal(result.next_offset, null);
  assert.deepEqual(result.rows.map((row) => row[0]), ["六區"]);
});

test("a town that keeps failing is listed in failed instead of silently missing", async () => {
  const seen = stubEmap({ towns: ["中正區", "大同區"], fail: new Set(["大同區"]) });
  const result = await (await call({ city: "台北市", offset: 0 })).json();
  assert.deepEqual(result.failed, ["大同區"]);
  assert.deepEqual(result.rows.map((row) => row[0]), ["中正區"]);
  assert.equal(seen.filter((p) => p.town === "大同區").length, 3, "retried before giving up");
});

test("no town list from the official site is an error, not an empty city", async () => {
  stubEmap({ townsDown: true });
  const response = await call({ city: "台北市", offset: 0 });
  assert.equal(response.status, 502);
});

test("only admins, whitelisted cities and sane offsets reach the official site", async () => {
  let seen = stubEmap({ admin: false });
  assert.equal((await call({ city: "台北市", offset: 0 })).status, 403);
  assert.equal(seen.length, 0);
  for (const body of [{ city: "東京都", offset: 0 }, { city: "constructor", offset: 0 }, { city: "台北市", offset: -1 }, { city: "台北市", offset: 1.5 }, { city: "台北市", offset: 999 }]) {
    seen = stubEmap();
    assert.equal((await call(body)).status, 400, JSON.stringify(body));
    assert.equal(seen.length, 0);
  }
});

test("batches stay small enough for the Workers Free CPU limit", () => {
  assert.ok(fetchModule.EMAP_TOWNS_PER_REQUEST <= 3);
});

test("official city ids cover exactly the checkout city whitelist (24 is 連江, 25 is 金門)", () => {
  assert.deepEqual(Object.keys(fetchModule.EMAP_CITY_IDS).sort(), Object.keys(CVS_CITY_SLUGS).sort());
  assert.equal(fetchModule.EMAP_CITY_IDS["連江縣"], "24");
  assert.equal(fetchModule.EMAP_CITY_IDS["金門縣"], "25");
});

test("parses a real SearchStore response", () => {
  const xml = '<?xml version="1.0" encoding="utf-8"?><iMapSDKOutput><MessageID>00000</MessageID><CommandID>SearchStore</CommandID><Status>連線成功</Status><TimeStamp>2026/10/19 上午 11:55:41</TimeStamp><GeoPosition><POIID>211594              </POIID><POIName>石錠</POIName><X>121655495</X><Y>24991746</Y><Telno>(02)26631417        </Telno><FaxNo>(02)26631410        </FaxNo><Address>新北市石碇區碇坪路一段50之1號50之2號</Address><SpecialStore_Kind></SpecialStore_Kind><Store_URL></Store_URL><StoreImageTitle>02廁所,03ATM,04座位區</StoreImageTitle><OP_DAY></OP_DAY><OP_TIME>06:00 ~ 23:00</OP_TIME></GeoPosition></iMapSDKOutput>';
  assert.deepEqual(fetchModule.parseStores(xml), [["211594", "石錠", "新北市石碇區碇坪路一段50之1號50之2號"]]);
  assert.deepEqual(fetchModule.parseTownNames(townsXml(["板橋區", "三重區"])), ["板橋區", "三重區"]);
});
