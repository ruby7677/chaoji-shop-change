// 結帳前加 LINE 好友：連結用 %40 編碼的官方帳號 ID，LIFF 加好友視窗失敗時改開連結。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { liffState, openLineUrl } from "../../public/liff-auth.js";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("the add-friend link encodes @ as %40 and the dialog shows the ID for manual search", async () => {
  const html = await read("public/index.html");
  const link = html.match(/<a [^>]*data-line-friend-request[^>]*>/)[0];
  assert.match(link, /href="https:\/\/line\.me\/R\/ti\/p\/%40078isxfl"/);
  assert.match(html, /class="line-friend-id"[^<]*<strong>@078isxfl<\/strong>/);
});

test("a failed liff.requestFriendship falls back to opening the add-friend link", async () => {
  const source = await read("public/member-benefits.js");
  const handler = source.slice(source.indexOf("export async function handleLineFriendRequest"));
  const fallback = handler.slice(handler.indexOf("} catch (error) {"), handler.indexOf("return true;"));
  assert.match(fallback, /if \(!openLineUrl\(button\.href\)\) window\.open\(button\.href, "_blank", "noopener"\);/);
});

test("openLineUrl opens inside LINE only after LIFF is initialized", () => {
  const opened = [];
  globalThis.liff = { openWindow: (options) => opened.push(options) };
  try {
    liffState.initialized = false;
    assert.equal(openLineUrl("https://line.me/R/ti/p/%40078isxfl"), false);
    liffState.initialized = true;
    assert.equal(openLineUrl("https://line.me/R/ti/p/%40078isxfl"), true);
    assert.deepEqual(opened, [{ url: "https://line.me/R/ti/p/%40078isxfl", external: false }]);
  } finally {
    liffState.initialized = false;
    delete globalThis.liff;
  }
});
