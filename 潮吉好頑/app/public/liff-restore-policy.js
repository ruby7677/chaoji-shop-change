// LIFF 持久登入恢復的失敗分類：暫時性故障（限流、Worker／LINE／Supabase 暫時無法回應）要重試，
// 不能當成「登入已失效」而自動改走 LINE OAuth（會出現 LINE 原生的「登入中…」黑幕並整頁跳轉）。
export const RESTORE_RETRY_DELAY_MS = 1200;

export function isRetryableRestoreStatus(status) {
  const code = Number(status);
  return code === 429 || code >= 500;
}
