// 後台新增／設定類表單改為右側滑出面板（ADMIN_REDESIGN_PLAN Stage 7，G10）＋面板說明文字收合。
// 做法：沿用各頁既有的 <details class="admin-create">，內容包進面板容器；表單元素、id、直接綁定的 submit 監聽與 document 委派都不受影響。
// 開啟時把面板移到 #admin-dialog 最外層（與遮罩同層），關閉時放回 <details>：iOS／LINE WebKit 中，
// 捲動容器內的 position:fixed 會被困在容器圖層（被遮罩蓋住或跟著捲動內容定位），手機上只看到灰色遮罩。
import { adminIcon } from "./admin-icons.js";

let dialog = null;
let scrim = null;
let lastTrigger = null;
const panelOf = new WeakMap();
const detailsOf = new WeakMap();

const sheets = () => [...dialog.querySelectorAll("details.admin-sheet")];
const openSheet = () => sheets().find((details) => details.open) || null;

function enhanceSheet(details) {
  if (details.classList.contains("admin-sheet")) return;
  const summary = details.querySelector(":scope > summary");
  if (!summary) return;
  details.classList.add("admin-sheet");
  details.removeAttribute("open");
  details.removeAttribute("data-admin-mobile-collapse");
  const title = summary.textContent.trim();
  const panel = document.createElement("div");
  panel.className = "admin-sheet-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", title);
  const head = document.createElement("header");
  head.className = "admin-sheet-head";
  head.innerHTML = `<h3></h3><button class="admin-icon-button" type="button" data-admin-sheet-close aria-label="關閉「${title.replace(/"/g, "")}」">${adminIcon("x")}</button>`;
  head.querySelector("h3").textContent = title;
  head.querySelector("h3").tabIndex = -1;
  const body = document.createElement("div");
  body.className = "admin-sheet-body";
  [...details.childNodes].filter((node) => node !== summary).forEach((node) => body.append(node));
  panel.append(head, body);
  details.append(panel);
  panelOf.set(details, panel);
  detailsOf.set(panel, details);
  summary.classList.add("admin-sheet-trigger");
  summary.insertAdjacentHTML("afterbegin", adminIcon("arrow"));
}

// 表單所屬的面板 <details>（面板可能已移出 <details>）
function sheetOf(node) {
  const panel = node?.closest?.(".admin-sheet-panel");
  return panel ? detailsOf.get(panel) || null : null;
}

function placePanel(details) {
  const panel = panelOf.get(details);
  if (!panel) return;
  if (details.open && panel.parentElement !== dialog) dialog.append(panel);
  else if (!details.open && panel.parentElement !== details) details.append(panel);
}

// iOS Safari：鍵盤彈出或對 fixed 面板內元素捲動時會捲動整頁，鍵盤收起後頁面停在位移後的位置，
// fixed 面板的點擊判定就與畫面錯開。面板開啟期間記住整頁捲動位置，輸入結束後捲回。
const isTouchPointer = () => window.matchMedia("(pointer: coarse)").matches;
let pageScroll = null;

function restorePageScroll() {
  if (pageScroll && (window.scrollX !== pageScroll.x || window.scrollY !== pageScroll.y)) window.scrollTo({ left: pageScroll.x, top: pageScroll.y, behavior: "instant" });
}

const isTextEntry = (node) => node instanceof HTMLElement && node.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select");

// opened：剛被打開的面板（優先保留它，關掉其他）
function syncScrim(opened = null) {
  const current = opened?.open ? opened : openSheet();
  scrim.hidden = !current;
  dialog.classList.toggle("has-open-sheet", Boolean(current));
  if (current) {
    // 一次只開一個面板
    sheets().forEach((details) => { if (details !== current && details.open) details.open = false; });
    if (!pageScroll) pageScroll = { x: window.scrollX, y: window.scrollY };
    const panel = panelOf.get(current);
    const body = panel?.querySelector(".admin-sheet-body");
    if (body) body.scrollTop = 0;
    // 觸控裝置不自動聚焦輸入框：避免一開啟就彈出鍵盤造成整頁位移；改聚焦標題供螢幕閱讀器朗讀
    const target = isTouchPointer()
      ? panel?.querySelector(".admin-sheet-head h3")
      : panel?.querySelector(".admin-sheet-body input:not([type=hidden]), .admin-sheet-body select, .admin-sheet-body textarea");
    target?.focus({ preventScroll: true });
  } else {
    restorePageScroll();
    pageScroll = null;
    if (lastTrigger?.isConnected) {
      lastTrigger.focus({ preventScroll: true });
      lastTrigger = null;
    }
  }
}

function closeSheets() {
  sheets().forEach((details) => { details.open = false; });
}

// 面板的「使用者主動關閉前」確認函式：details -> async () => boolean。
const beforeCloseOf = new WeakMap();
// 避免使用者在等待 beforeClose 回覆（例如未儲存修改的確認視窗）時連續按 ✕／Esc／遮罩，重複觸發確認。
let closingSheet = null;

// 使用者主動關閉「目前開啟的面板」的 3 條路徑（✕、點遮罩、Esc）都會走這裡：若該面板建立時有給
// beforeClose，等待它回傳 true 才真的關閉，回傳 false 就保留原狀。其他會關閉面板的路徑——切換後台分頁、
// 整個後台 <dialog> 關閉、開啟另一個面板（見 syncScrim 內把其他 details.open 設為 false）——都是直接呼叫
// closeSheets() 或設定 details.open，不經過這裡，維持原本「不詢問」的行為（那些是系統性切換情境，不是
// 使用者針對「這個面板」按下關閉）。
async function requestCloseOpenSheet() {
  const current = openSheet();
  if (!current || closingSheet === current) return;
  const guard = beforeCloseOf.get(current);
  if (!guard) { current.open = false; return; }
  closingSheet = current;
  try {
    const allowed = await guard();
    if (allowed && current.open) current.open = false;
  } finally {
    if (closingSheet === current) closingSheet = null;
  }
}

// 其他模組動態建立的面板（沒有觸發按鈕，例如商品列表每列的「編輯」「優惠價」），共用遮罩、Esc 與 iOS 修正。
// options.beforeClose：選填，使用者主動關閉此面板前呼叫的 async () => boolean，回傳 false 取消關閉。
export function createAdminSheet(host, title, options = {}) {
  if (!dialog) throw new Error("後台面板尚未初始化");
  const details = document.createElement("details");
  details.className = "admin-create admin-sheet-dynamic";
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.append(summary);
  host.append(details);
  enhanceSheet(details);
  if (typeof options.beforeClose === "function") beforeCloseOf.set(details, options.beforeClose);
  const panel = panelOf.get(details);
  const heading = panel.querySelector(".admin-sheet-head h3");
  const closeButton = panel.querySelector("[data-admin-sheet-close]");
  return {
    details,
    body: panel.querySelector(".admin-sheet-body"),
    setTitle(text) {
      heading.textContent = text;
      panel.setAttribute("aria-label", text);
      closeButton.setAttribute("aria-label", `關閉「${text}」`);
    },
    // trigger：關閉後焦點回到的按鈕
    open(trigger = null) {
      lastTrigger = trigger;
      details.open = true;
    },
    close() { details.open = false; }
  };
}

// 開啟某個表單所在的既有面板（例如「＋」開啟新增商品）
export function openAdminSheetFor(node, trigger = null) {
  const details = sheetOf(node);
  if (!details) return false;
  lastTrigger = trigger;
  details.open = true;
  return true;
}

// 面板頂部說明文字預設隱藏，改由標題旁的「ⓘ」按鈕展開；保留原節點位置（其他模組以 > .dialog-copy 直接子選擇器更新文字）
function enhanceHelpText() {
  dialog.querySelectorAll(".admin-panel > .dialog-copy").forEach((copy, index) => {
    if (copy.dataset.adminHelp) return;
    const heading = copy.parentElement.querySelector(":scope > h2");
    if (!heading) return;
    copy.dataset.adminHelp = "true";
    copy.id ||= `admin-help-${index}`;
    copy.classList.add("admin-help");
    copy.hidden = true;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "admin-help-toggle";
    toggle.dataset.adminHelpToggle = copy.id;
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", copy.id);
    toggle.setAttribute("aria-label", `${heading.textContent.trim()}說明`);
    toggle.title = "說明";
    toggle.innerHTML = adminIcon("info");
    heading.append(toggle);
  });
}

export function initAdminSheets() {
  if (dialog) return;
  dialog = document.querySelector("#admin-dialog");
  if (!dialog) return;
  dialog.querySelectorAll(".admin-panel details.admin-create").forEach(enhanceSheet);
  enhanceHelpText();
  scrim = document.createElement("div");
  scrim.className = "admin-sheet-scrim";
  scrim.hidden = true;
  scrim.dataset.adminSheetClose = "";
  dialog.append(scrim);
  dialog.addEventListener("toggle", (event) => {
    if (!(event.target instanceof HTMLDetailsElement) || !event.target.classList.contains("admin-sheet")) return;
    placePanel(event.target);
    syncScrim(event.target);
  }, true);
  dialog.addEventListener("click", (event) => {
    const trigger = event.target.closest(".admin-sheet-trigger");
    if (trigger) lastTrigger = trigger;
    if (event.target.closest("[data-admin-sheet-close]")) { requestCloseOpenSheet(); return; }
    const help = event.target.closest("[data-admin-help-toggle]");
    if (help) {
      const copy = document.getElementById(help.dataset.adminHelpToggle);
      if (!copy) throw new Error(`找不到說明文字：${help.dataset.adminHelpToggle}`);
      copy.hidden = !copy.hidden;
      help.setAttribute("aria-expanded", String(!copy.hidden));
    }
  });
  // 優惠券「編輯」會把資料填入表單（app.js editCoupon），這裡負責把表單面板打開
  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-coupon-edit]")) return;
    const details = sheetOf(document.querySelector("#admin-coupon-form"));
    if (details) details.open = true;
  });
  // 送出成功時 app.js 會重設該表單（form.reset）；失敗則保留資料。據此在成功後自動關閉面板
  const pendingForms = new WeakMap();
  dialog.addEventListener("submit", (event) => {
    if (event.target instanceof HTMLFormElement && sheetOf(event.target)) pendingForms.set(event.target, Date.now());
  }, true);
  dialog.addEventListener("reset", (event) => {
    const submittedAt = pendingForms.get(event.target);
    pendingForms.delete(event.target);
    if (!submittedAt || Date.now() - submittedAt > 10_000) return;
    const details = sheetOf(event.target);
    if (details) details.open = false;
  }, true);
  // 鍵盤收起（離開輸入框且沒有移到另一個輸入框）後捲回開啟面板時的整頁位置；等 Safari 鍵盤收合動畫結束
  const restoreAfterKeyboard = () => {
    if (!pageScroll || isTextEntry(document.activeElement)) return;
    restorePageScroll();
  };
  dialog.addEventListener("focusout", (event) => {
    if (!pageScroll || !isTextEntry(event.target) || !event.target.closest(".admin-sheet-panel")) return;
    window.setTimeout(restoreAfterKeyboard, 320);
  });
  window.visualViewport?.addEventListener("resize", restoreAfterKeyboard);
  // 面板開啟時 Esc 只關閉面板，不關閉整個後台。
  // 主要在 keydown 攔截：Chrome 的 close watcher 在缺少使用者啟用時會送出「不可取消」的 cancel，
  // 只靠 cancel 的 preventDefault 會讓整個後台被關掉；取消 Esc 的 keydown 則不會產生關閉請求。
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !openSheet()) return;
    // 確認框開著時交給 admin-confirm.js 處理（它也在 keydown 取消確認）
    if (dialog.querySelector(".admin-confirm-scrim:not([hidden])")) return;
    event.preventDefault();
    window.setTimeout(() => { void requestCloseOpenSheet(); }, 0);
  });
  // 備援：非鍵盤觸發的關閉請求（例如 Android 返回鍵）仍走 cancel
  dialog.addEventListener("cancel", (event) => {
    if (!openSheet()) return;
    event.preventDefault();
    // 確認框開著時，Esc 只交給 admin-confirm.js 取消確認，不再發起新的關閉請求
    if (dialog.querySelector(".admin-confirm-scrim:not([hidden])")) return;
    // 延到這次 Esc 事件分派結束後才處理：beforeClose 會開 adminConfirm，而 admin-confirm.js 也監聽同一個 cancel，
    // 若同步開啟，確認框會被同一次 Esc 立刻當成「取消」關掉
    window.setTimeout(() => { void requestCloseOpenSheet(); }, 0);
  });
  // 切換分頁或關閉後台時收起面板
  // 只在作用中分頁實際改變時收起（徽章更新也會觸發 class 變動，不能誤關）
  let activeTab = dialog.querySelector("[data-admin-tab].active")?.dataset.adminTab;
  new MutationObserver(() => {
    const next = dialog.querySelector("[data-admin-tab].active")?.dataset.adminTab;
    if (next === activeTab) return;
    activeTab = next;
    closeSheets();
  }).observe(dialog.querySelector(".admin-nav"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => { if (!dialog.open) closeSheets(); }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
}
