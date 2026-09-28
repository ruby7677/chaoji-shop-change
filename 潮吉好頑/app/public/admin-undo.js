// 後台「復原」提示列：可逆操作（規格上下架）成功後顯示 8 秒，按「復原」執行反向操作。
// 共用 toast 只停 3 秒且前後台共用，這裡另做一條只在後台出現、同時只保留一則的提示列。
const UNDO_TIMEOUT_MS = 8000;
let bar = null;
let timer = 0;
let pending = null;

function ensureBar() {
  if (bar?.isConnected) return bar;
  const dialog = document.querySelector("#admin-dialog");
  if (!dialog) throw new Error("後台尚未載入，無法顯示復原提示");
  bar = document.createElement("div");
  bar.className = "admin-undo";
  bar.hidden = true;
  bar.setAttribute("role", "status");
  bar.innerHTML = '<span class="admin-undo-text"></span><button type="button" class="admin-undo-button">復原</button>';
  bar.querySelector("button").addEventListener("click", async () => {
    const action = pending;
    dismissUndo();
    if (action) await action();
  });
  dialog.append(bar);
  return bar;
}

export function dismissUndo() {
  window.clearTimeout(timer);
  pending = null;
  if (bar) bar.hidden = true;
}

// onUndo 需自行處理錯誤回報（例如 showToast）；新的一則會取代舊的
export function offerUndo(message, onUndo) {
  if (typeof onUndo !== "function") throw new Error("offerUndo 需要復原動作");
  const node = ensureBar();
  window.clearTimeout(timer);
  pending = onUndo;
  node.querySelector(".admin-undo-text").textContent = message;
  node.hidden = false;
  timer = window.setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
}
