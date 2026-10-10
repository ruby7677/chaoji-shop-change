// LINE 登入回呼錯誤訊息（見 auth-error-message.js 開頭說明）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { authReturnErrorMessage } from "../../public/auth-error-message.js";

const fragment = (hash) => new URLSearchParams(hash);

test("沒有錯誤時回傳 null", () => {
  assert.equal(authReturnErrorMessage(fragment("access_token=x")), null);
});

test("會員在 LINE 同意畫面取消：access_denied 且沒有 error_code", () => {
  assert.equal(authReturnErrorMessage(fragment("error=access_denied&error_description=The+user+has+denied")), "你已取消 LINE 登入");
});

test("Supabase 關閉註冊不是會員取消", () => {
  assert.equal(
    authReturnErrorMessage(fragment("error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance")),
    "目前暫停新會員註冊，請聯絡客服"
  );
});

test("其他帶 error_code 的錯誤顯示一般訊息", () => {
  assert.equal(authReturnErrorMessage(fragment("error=access_denied&error_code=unexpected_failure")), "LINE 登入未完成，請稍後再試");
  assert.equal(authReturnErrorMessage(fragment("error=server_error")), "LINE 登入未完成，請稍後再試");
});
