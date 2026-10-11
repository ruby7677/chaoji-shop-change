// 開機時的會員登入恢復（LIFF 橋接或網頁工作階段＋會員資料）可能在畫面顯示後才完成。
// 需要會員身分的入口（登入按鈕、結帳、我的訂單）先等它，避免恢復途中被誤判為未登入而導去 LINE 授權。
import { showToast } from "./app-core.js";

let settled = false;
let resolveSettled = () => {};
const settledPromise = new Promise((resolve) => { resolveSettled = resolve; });

/** 開機流程完成會員載入（或失敗、轉址）時呼叫一次；之後的呼叫無作用。 */
export function markAuthSettled() {
  settled = true;
  resolveSettled();
}

// 背景恢復最多等這麼久：某個請求一直沒回應時，按鈕仍會以當下的登入狀態繼續（未登入就改走 LINE 登入）
const AUTH_READY_TIMEOUT_MS = 10000;

/** 會員登入恢復完成前等待（有上限）；等待中提示一次，讓按下按鈕的客人知道不是沒反應。 */
export async function whenAuthReady() {
  if (settled) return;
  showToast("正在確認登入狀態…");
  await Promise.race([settledPromise, new Promise((resolve) => setTimeout(resolve, AUTH_READY_TIMEOUT_MS))]);
}
