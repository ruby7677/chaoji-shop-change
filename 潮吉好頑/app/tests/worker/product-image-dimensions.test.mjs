// 商品主圖寬高：從檔頭讀出 PNG／JPEG／WebP 寬高；上傳時寫入商品；每小時排程補齊既有照片；
// 首頁 HTML 預先載入型錄與第一張輪播圖（選圖規則與前台 selectHeroSlides 相同）。
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, formDataRequestInit, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";
import { selectHeroSlides } from "../../public/hero-slides.js";

const { readImageDimensions } = await loadSourceModule("image-dimensions.ts");
const { firstHeroImageUrl } = await loadSourceModule("hero-preload.ts");
const { homePreloadMarkup } = await loadSourceModule("share-meta.ts");
const worker = await loadWorker();

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const LINE_ID = "U" + "a".repeat(32);
let restoreFetch = () => {};
let originalCaches;
// Node 沒有 Cache API：上傳後清除型錄與圖片的邊緣快取，以記憶體假冒
beforeEach(() => {
  originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
});
afterEach(() => {
  restoreFetch();
  globalThis.caches = originalCaches;
});

const le24 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const be16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value) => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const text = (value) => [...value].map((char) => char.charCodeAt(0));
const riff = (chunk, payload) => new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(chunk), 0, 0, 0, 0, ...payload]);

const webpExtended = (width, height) => riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
function webpLossless(width, height) {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0]);
}
const webpLossy = (width, height) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8]);
const png = (width, height) => new Uint8Array([0x89, ...text("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...text("IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]);
// APP0（JFIF）在 SOF0 前面，確認會跳過其他區段
const jpeg = (width, height) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...new Array(14).fill(0), 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 0, 0, 0, 0, 0, 0]);

test("reads width and height from PNG, JPEG and every WebP flavour", () => {
  assert.deepEqual(readImageDimensions(png(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(readImageDimensions(jpeg(1200, 900)), { width: 1200, height: 900 });
  assert.deepEqual(readImageDimensions(webpExtended(750, 1000)), { width: 750, height: 1000 });
  assert.deepEqual(readImageDimensions(webpLossless(416, 411)), { width: 416, height: 411 });
  assert.deepEqual(readImageDimensions(webpLossy(501, 424)), { width: 501, height: 424 });
});

test("unknown or truncated data gives no dimensions instead of guessing", () => {
  assert.equal(readImageDimensions(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(readImageDimensions(webpExtended(750, 1000).slice(0, 20)), null);
  assert.equal(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0])), null, "no frame header before the image data");
});

function fakeUploadSupabase() {
  const patches = [];
  restoreFetch = stubFetch(async (url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/products" && init.method === "PATCH") { patches.push({ query: url.search, body }); return new Response(null, { status: 204 }); }
    if (url.pathname === "/rest/v1/products") return jsonResponse([{ id: PRODUCT_ID, image_path: null, image_updated_at: null }]);
    if (url.pathname === "/rest/v1/rpc/admin_update_product_image") return jsonResponse({});
    if (url.pathname.startsWith("/storage/v1/object/")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  });
  return patches;
}

async function upload(file) {
  const formData = new FormData();
  formData.append("image", file);
  const { body, headers } = await formDataRequestInit(formData);
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/image`, {
    method: "POST", headers: { Authorization: "Bearer admin-access-token", ...headers }, body
  }), baseEnv, ctx());
}

test("uploading a main image stores its width and height on the product", async () => {
  const patches = fakeUploadSupabase();
  const response = await upload(new File([webpExtended(750, 1000)], "main.webp", { type: "image/webp" }));
  assert.equal(response.status, 200);
  assert.deepEqual(patches, [{ query: `?id=eq.${PRODUCT_ID}`, body: { image_width: 750, image_height: 1000 } }]);
});

test("an image whose size cannot be read clears the old dimensions so the old ratio is not reused", async () => {
  const patches = fakeUploadSupabase();
  const response = await upload(new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "main.jpg", { type: "image/jpeg" }));
  assert.equal(response.status, 200);
  assert.deepEqual(patches.map((patch) => patch.body), [{ image_width: null, image_height: null }]);
});

test("the hourly schedule fills in dimensions for existing photos from the file header only", async () => {
  const patches = [];
  const ranges = [];
  restoreFetch = stubFetch(async (url, init, body) => {
    if (url.pathname === "/rest/v1/products" && init.method === "PATCH") { patches.push({ query: url.search, body }); return new Response(null, { status: 204 }); }
    if (url.pathname === "/rest/v1/products") {
      assert.match(url.search, /image_width=is\.null/);
      return jsonResponse([{ id: "p1", image_path: "p1/primary.webp" }, { id: "p2", image_path: "p2/primary.png" }]);
    }
    if (url.pathname.startsWith("/storage/v1/object/product-images/")) {
      ranges.push(new Headers(init.headers).get("Range"));
      return new Response(url.pathname.endsWith(".png") ? png(300, 600) : webpLossless(800, 800), { status: 206 });
    }
    return jsonResponse([]);
  });
  const execution = ctx();
  await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.UTC(2026, 9, 8, 5) }, baseEnv, execution);
  await execution.settle();
  assert.deepEqual(ranges, ["bytes=0-65535", "bytes=0-65535"]);
  assert.deepEqual(patches, [
    { query: "?id=eq.p1", body: { image_width: 800, image_height: 800 } },
    { query: "?id=eq.p2", body: { image_width: 300, image_height: 600 } }
  ]);
});

const variant = (overrides) => ({ id: "v", product_id: "p", stock: 1, type: "現貨", image_url: "/img/p", hero_rank: null, display_order: 0, ...overrides });
const catalogs = {
  ranked: [
    variant({ id: "a", product_id: "pa", hero_rank: 2, image_url: "/img/a" }),
    variant({ id: "b", product_id: "pb", hero_rank: 1, image_url: "/img/b" }),
    variant({ id: "c", product_id: "pc", hero_rank: 1, display_order: 5, image_url: "/img/c" })
  ],
  soldOutLead: [
    variant({ id: "x1", product_id: "px", stock: 0, hero_rank: 1, image_url: "/img/x1" }),
    variant({ id: "x2", product_id: "px", stock: 3, hero_rank: 4, image_url: "/img/x2" }),
    variant({ id: "y", product_id: "py", hero_rank: 3, image_url: "/img/y" })
  ],
  newestPreorder: [
    variant({ id: "s", product_id: "ps", type: "現貨", display_order: 9, image_url: "/img/s" }),
    variant({ id: "o", product_id: "po", type: "預購", display_order: 1, image_url: "/img/o" }),
    variant({ id: "n", product_id: "pn", type: "預購", display_order: 7, image_url: "/img/n" })
  ],
  noImage: [variant({ id: "z", product_id: "pz", hero_rank: 1, image_url: undefined })]
};

test("the preloaded hero image is the first slide the storefront shows", () => {
  for (const [name, products] of Object.entries(catalogs)) {
    assert.equal(firstHeroImageUrl(products), selectHeroSlides(products)[0]?.imageUrl ?? null, name);
  }
});

// 慢的情境放前面：型錄在 isolate 內快取 30 秒，成功載入後同一模組不會再等
test("a slow catalog only skips the hero image preload instead of holding the page", async () => {
  // 型錄 400ms 後才失敗（不會被快取）；測試結束前等它結束，避免下一個測試共用這次的讀取
  restoreFetch = stubFetch(() => new Promise((resolve) => setTimeout(() => resolve(jsonResponse({}, 500)), 400)));
  const started = Date.now();
  const execution = ctx();
  const markup = await homePreloadMarkup(baseEnv, new URL("https://slow.test/"), execution);
  assert.ok(Date.now() - started < 1000);
  assert.equal(markup, '<link rel="preload" href="/api/catalog" as="fetch" crossorigin="anonymous" />');
  // 首頁回應送出後型錄讀取仍交給 waitUntil 完成，之後的 /api/catalog 才不會卡在被中斷的讀取
  await execution.settle();
});

// Node 沒有 HTMLRewriter：這裡驗證要插入首頁的標記；插入位置（charset 之後）由 share-meta.ts 的 HTMLRewriter 規則負責
test("the home page preloads the catalog and the first hero image", async () => {
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/rest/v1/storefront_variants") return jsonResponse([{ ...variant({ id: "h", product_id: PRODUCT_ID, hero_rank: 1 }), has_image: true, image_updated_at: "2026-10-08" }]);
    return jsonResponse([]);
  });
  const markup = await homePreloadMarkup(baseEnv, new URL("https://preload.test/"));
  assert.match(markup, /<link rel="preload" href="\/api\/catalog" as="fetch" crossorigin="anonymous" \/>/);
  assert.match(markup, new RegExp(`<link rel="preload" href="/api/product-images/${PRODUCT_ID}\\?v=2026-10-08" as="image" fetchpriority="high" />`));
});
