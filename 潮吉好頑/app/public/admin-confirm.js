// 後台共用的畫面內確認視窗，取代 window.confirm：部分瀏覽器／內嵌 WebView 會直接略過系統確認框或回傳 false，
// 導致按了沒反應（ADMIN_REDESIGN_PLAN 第 9 節）。回傳 Promise<boolean>；取消、Esc、點遮罩皆為 false。
let box = null;

function build() {
  const dialog = document.querySelector("#admin-dialog");
  if (!dialog) throw new Error("後台尚未載入，無法顯示確認視窗");
  const scrim = document.createElement("div");
  scrim.className = "admin-confirm-scrim";
  scrim.hidden = true;
  scrim.innerHTML = '<div class="admin-confirm" role="alertdialog" aria-modal="true" aria-labelledby="admin-confirm-title" aria-describedby="admin-confirm-details admin-confirm-message">'
    + '<h3 id="admin-confirm-title"></h3><dl id="admin-confirm-details" class="admin-confirm-details" hidden></dl><div id="admin-confirm-message" class="admin-confirm-message"></div>'
    + '<div class="admin-confirm-actions"><button class="secondary-button" type="button" data-confirm-cancel>取消</button><button class="primary-button" type="button" data-confirm-ok></button></div></div>';
  dialog.append(scrim);
  const title = scrim.querySelector("#admin-confirm-title");
  const details = scrim.querySelector("#admin-confirm-details");
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
  // Esc 只取消確認，不關閉整個後台：在 keydown 就攔截（原因同 admin-sheets.js，cancel 可能不可取消）
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || scrim.hidden) return;
    event.preventDefault();
    finish(false);
  });
  dialog.addEventListener("cancel", (event) => {
    if (scrim.hidden) return;
    event.preventDefault();
    finish(false);
  });
  return {
    ask({ title: heading, message: text = "", details: rows = null, confirmLabel = "確定", danger = false, trigger = null }) {
      // 前一個確認尚未回覆就又被觸發：視為取消，避免遺留未完成的 Promise
      if (resolver) finish(false);
      title.textContent = heading;
      // details：[label, value] 陣列，畫成兩欄 dl；沒有內容就整個隱藏
      details.replaceChildren();
      const detailRows = Array.isArray(rows) ? rows : [];
      detailRows.forEach(([label, value]) => {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        details.append(dt, dd);
      });
      details.hidden = detailRows.length === 0;
      // message：單一字串或多行字串陣列（例如多條警語），各自獨立一行
      message.replaceChildren();
      const lines = (Array.isArray(text) ? text : [text]).filter(Boolean);
      lines.forEach((line) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        message.append(paragraph);
      });
      message.hidden = lines.length === 0;
      ok.textContent = confirmLabel;
      ok.classList.toggle("is-danger", danger);
      returnFocus = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      scrim.hidden = false;
      scrim.querySelector("[data-confirm-cancel]").focus({ preventScroll: true });
      return new Promise((resolve) => { resolver = resolve; });
    }
  };
}

// options：{ title, message, details, confirmLabel, danger, trigger }（message 可為字串或多行字串陣列；details 為 [label, value] 陣列；trigger：關閉後焦點回到的元素）
export function adminConfirm(options) {
  box ||= build();
  return box.ask(options);
}
