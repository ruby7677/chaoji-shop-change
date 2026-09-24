// 後台共用的畫面內確認視窗，取代 window.confirm：部分瀏覽器／內嵌 WebView 會直接略過系統確認框或回傳 false，
// 導致按了沒反應（ADMIN_REDESIGN_PLAN 第 9 節）。回傳 Promise<boolean>；取消、Esc、點遮罩皆為 false。
let box = null;

function build() {
  const dialog = document.querySelector("#admin-dialog");
  if (!dialog) throw new Error("後台尚未載入，無法顯示確認視窗");
  const scrim = document.createElement("div");
  scrim.className = "admin-confirm-scrim";
  scrim.hidden = true;
  scrim.innerHTML = '<div class="admin-confirm" role="alertdialog" aria-modal="true" aria-labelledby="admin-confirm-title" aria-describedby="admin-confirm-message">'
    + '<h3 id="admin-confirm-title"></h3><p id="admin-confirm-message"></p>'
    + '<div class="admin-confirm-actions"><button class="secondary-button" type="button" data-confirm-cancel>取消</button><button class="primary-button" type="button" data-confirm-ok></button></div></div>';
  dialog.append(scrim);
  const title = scrim.querySelector("#admin-confirm-title");
  const message = scrim.querySelector("#admin-confirm-message");
  const ok = scrim.querySelector("[data-confirm-ok]");
  let resolver = null;
  let returnFocus = null;
  const finish = (result) => {
    const resolve = resolver;
    resolver = null;
    scrim.hidden = true;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    resolve?.(result);
  };
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim || event.target.closest("[data-confirm-cancel]")) finish(false);
    else if (event.target.closest("[data-confirm-ok]")) finish(true);
  });
  // Esc 只取消確認，不關閉整個後台
  dialog.addEventListener("cancel", (event) => {
    if (scrim.hidden) return;
    event.preventDefault();
    finish(false);
  });
  return {
    ask({ title: heading, message: text = "", confirmLabel = "確定", danger = false, trigger = null }) {
      // 前一個確認尚未回覆就又被觸發：視為取消，避免遺留未完成的 Promise
      if (resolver) finish(false);
      title.textContent = heading;
      message.textContent = text;
      message.hidden = !text;
      ok.textContent = confirmLabel;
      ok.classList.toggle("is-danger", danger);
      returnFocus = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      scrim.hidden = false;
      scrim.querySelector("[data-confirm-cancel]").focus({ preventScroll: true });
      return new Promise((resolve) => { resolver = resolve; });
    }
  };
}

// options：{ title, message, confirmLabel, danger, trigger }（trigger：關閉後焦點回到的元素）
export function adminConfirm(options) {
  box ||= build();
  return box.ask(options);
}
