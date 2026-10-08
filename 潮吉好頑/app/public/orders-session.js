// 獨立訂單頁的會員登入：LINE App 內以 LIFF ID token 恢復會員在商店保存的登入（/api/auth/session/restore），
// 一般瀏覽器以 web-session cookie 換發。access token 存在 sessionStorage「cj-auth」（與商店同格式），
// 同一分頁重新整理不必再呼叫 Worker。
import { accessTokenExpiresSoon } from "./auth-expiry.js";
import { RESTORE_RETRY_DELAY_MS, isRetryableRestoreStatus } from "./liff-restore-policy.js";

const STORAGE_KEY = "cj-auth";

export function cachedAccessToken(storage = globalThis.sessionStorage) {
  try {
    const token = JSON.parse(storage.getItem(STORAGE_KEY) || "null")?.accessToken;
    return typeof token === "string" && token && !accessTokenExpiresSoon(token) ? token : null;
  } catch {
    return null;
  }
}

export function rememberAccessToken(token, storage = globalThis.sessionStorage) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ accessToken: token, refreshToken: null, lineProviderToken: null })); }
  catch { /* restricted storage */ }
}

export function forgetAccessToken(storage = globalThis.sessionStorage) {
  try { storage.removeItem(STORAGE_KEY); } catch { /* restricted storage */ }
}

async function restoreOnce(idToken, fetchImpl) {
  let response;
  try {
    response = await fetchImpl("/api/auth/session/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken })
    });
  } catch {
    return { outcome: "retry" };
  }
  if (isRetryableRestoreStatus(response.status)) return { outcome: "retry" };
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") return { outcome: "failed" };
  return { outcome: "restored", accessToken: result.access_token };
}

// 回傳 restored（含 accessToken）、failed（沒有保存的登入，需先到商店登入一次）或 retry（暫時性故障，重試一次後仍失敗）
export async function restoreOrdersSession({ idToken, fetchImpl = globalThis.fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!idToken) return { outcome: "failed" };
  const first = await restoreOnce(idToken, fetchImpl);
  if (first.outcome !== "retry") return first;
  await wait(RESTORE_RETRY_DELAY_MS);
  return restoreOnce(idToken, fetchImpl);
}
