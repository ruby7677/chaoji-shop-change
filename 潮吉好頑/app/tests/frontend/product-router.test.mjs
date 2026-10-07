// 商品頁路由：從列表點進來（含再點推薦商品）時，分類連結退回列表那筆紀錄並還原離開時的捲動位置；
// 直接開啟分享連結時沒有列表可退，交給 goHome 跳到列表開頭。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// 最小的瀏覽器歷史紀錄替身：pushState／replaceState／go 與 popstate
function fakeBrowser(startPath) {
  const entries = [{ state: null, url: startPath }];
  let index = 0;
  const listeners = [];
  const setUrl = (url) => { const parsed = new URL(url, "https://shop.test"); globalThis.location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash }; };
  globalThis.window = { scrollY: 0, addEventListener: (type, fn) => type === "popstate" && listeners.push(fn) };
  globalThis.history = {
    get state() { return entries[index].state; },
    pushState(state, _title, url) { entries.splice(index + 1); entries.push({ state, url }); index += 1; setUrl(url); },
    replaceState(state, _title, url = entries[index].url) { entries[index] = { state, url }; setUrl(url); },
    go(delta) { index += delta; setUrl(entries[index].url); listeners.forEach((fn) => fn()); }
  };
  setUrl(startPath);
}

let calls;
const { createProductRouter } = await import("../../public/product-router.js");
const makeRouter = () => createProductRouter({ onProduct: (id) => calls.push(["product", id]), onHome: (args) => calls.push(["home", args]) });

beforeEach(() => { calls = []; });

test("from the list, backToList returns to the list entry with the saved scroll position", () => {
  fakeBrowser("/");
  const router = makeRouter();
  window.scrollY = 4963;
  router.openProduct("p1");
  assert.equal(router.backToList(), true);
  assert.equal(location.pathname, "/");
  assert.deepEqual(calls.at(-1), ["home", { scrollY: 4963, hash: "" }]);
});

test("after opening a recommended product, backToList skips both product pages", () => {
  fakeBrowser("/");
  const router = makeRouter();
  window.scrollY = 1200;
  router.openProduct("p1");
  router.openProduct("p2");
  assert.equal(history.state.homeDepth, 2);
  assert.equal(router.backToList(), true);
  assert.deepEqual(calls.at(-1), ["home", { scrollY: 1200, hash: "" }]);
});

test("a product opened directly from a shared link has no list to return to", () => {
  fakeBrowser("/products/p1");
  const router = makeRouter();
  router.openProduct("p2");
  assert.equal(router.backToList(), false);
});

test("the product page's fallback home title and description match index.html", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../public/product-page.js", import.meta.url), "utf8");
  const [, title, description] = source.match(/HOME_META = \{ title: "([^"]+)", description: "([^"]+)" \}/);
  assert.ok(html.includes(`<title>${title}</title>`));
  assert.ok(html.includes(`<meta name="description" content="${description}" />`));
});

test("a saved scroll position wins over the list anchor in the URL", () => {
  fakeBrowser("/#quick-pick");
  const router = makeRouter();
  window.scrollY = 3000;
  router.openProduct("p1");
  router.backToList();
  assert.deepEqual(calls.at(-1), ["home", { scrollY: 3000, hash: "" }]);
});
