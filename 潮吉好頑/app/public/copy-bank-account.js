// 「複製匯款帳號」按鈕（首頁付款對話框與獨立訂單頁共用）；有處理到點擊時回傳 true。
import { showToast } from "./app-core.js";

export function handleCopyBankAccount(event) {
  const copyAccount = event.target.closest("[data-copy-bank-account]");
  if (!copyAccount) return false;
  const value = copyAccount.dataset.copyBankAccount || "";
  const copyPromise = navigator.clipboard?.writeText(value);
  if (!copyPromise) {
    showToast("目前瀏覽器不支援複製帳號", "warning");
    return true;
  }
  copyPromise.then(() => {
    const original = copyAccount.textContent;
    copyAccount.textContent = "已複製";
    showToast("匯款帳號已複製", "success");
    window.setTimeout(() => { copyAccount.textContent = original; }, 1800);
  }).catch(() => showToast("複製帳號失敗，請手動選取", "warning"));
  return true;
}
