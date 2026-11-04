// 首頁浮動「回到頂端」按鈕：捲動超過門檻才顯示、點擊回到頂端（尊重減少動態偏好）、沒有按鈕時不報錯；
// 導航列不再有 LINE 客服鈕，浮動 LINE 連結指向官方帳號且在商品頁隱藏。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initFloatingActions, scrollTopHidden } from "../../public/floating-actions.js";

function fakeEnvironment({ reduced = false } = {}) {
  const listeners = {};
  const clicks = [];
  const scrolls = [];
  const button = { hidden: true, addEventListener: (type, handler) => { clicks.push([type, handler]); } };
  const win = {
    scrollY: 0,
    addEventListener: (type, handler) => { listeners[type] = handler; },
    requestAnimationFrame: (callback) => callback(),
    matchMedia: () => ({ matches: reduced }),
    scrollTo: (options) => scrolls.push(options)
  };
  const root = { querySelector: (selector) => (selector === "[data-scroll-top]" ? button : null) };
  return { root, win, button, listeners, clicks, scrolls };
}

test("捲動不到門檻時隱藏、超過後顯示", () => {
  assert.equal(scrollTopHidden(0), true);
  assert.equal(scrollTopHidden(399), true);
  assert.equal(scrollTopHidden(400), false);
  assert.equal(scrollTopHidden(undefined), true);
});

test("捲動事件會更新按鈕顯示，初始狀態也會同步", () => {
  const env = fakeEnvironment();
  env.win.scrollY = 900;
  initFloatingActions(env.root, env.win);
  assert.equal(env.button.hidden, false);
  env.win.scrollY = 10;
  env.listeners.scroll();
  assert.equal(env.button.hidden, true);
});

test("點擊回到頂端；偏好減少動態時不使用平滑捲動", () => {
  for (const [reduced, behavior] of [[false, "smooth"], [true, "auto"]]) {
    const env = fakeEnvironment({ reduced });
    initFloatingActions(env.root, env.win);
    env.clicks.find(([type]) => type === "click")[1]();
    assert.deepEqual(env.scrolls, [{ top: 0, behavior }]);
  }
});

test("頁面沒有按鈕時不報錯也不綁事件", () => {
  const env = fakeEnvironment();
  initFloatingActions({ querySelector: () => null }, env.win);
  assert.deepEqual(env.listeners, {});
});

test("首頁：導航列沒有 LINE 鈕，浮動 LINE 連結指向官方帳號並另開視窗", async () => {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /nav-line-button/);
  const floating = html.match(/<div class="floating-actions"[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(floating, /href="https:\/\/line\.me\/R\/ti\/p\/@078isxfl[^"]*"[^>]*target="_blank"[^>]*rel="noreferrer"/);
  assert.match(floating, /data-scroll-top[^>]*hidden/);
  assert.doesNotMatch(floating, /style=/);
});

test("樣式：商品頁隱藏浮動按鈕，按鈕 40px 但觸控範圍擴到 48px，且不完全貼齊右邊界", async () => {
  const css = await readFile(new URL("../../public/floating-actions.css", import.meta.url), "utf8");
  assert.match(css, /body\.is-product-view \.floating-actions \{ display: none; \}/);
  assert.match(css, /width: 40px; height: 40px/);
  assert.match(css, /\.floating-actions \[hidden\] \{ display: none; \}/);
  assert.match(css, /bottom: calc\(70px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /::after \{ content: ""; position: absolute; inset: -4px; \}/);
  assert.match(css, /right: calc\(8px \+ env\(safe-area-inset-right\)\)/);
});
