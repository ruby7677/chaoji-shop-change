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

// opened：剛被打開的面板（優先保留它，關掉其他）
function syncScrim(opened = null) {
  const current = opened?.open ? opened : openSheet();
  scrim.hidden = !current;
  dialog.classList.toggle("has-open-sheet", Boolean(current));
  if (current) {
    // 一次只開一個面板
    sheets().forEach((details) => { if (details !== current && details.open) details.open = false; });
    panelOf.get(current)?.querySelector(".admin-sheet-body input:not([type=hidden]), .admin-sheet-body select, .admin-sheet-body textarea")?.focus({ preventScroll: true });
  } else if (lastTrigger?.isConnected) {
    lastTrigger.focus({ preventScroll: true });
    lastTrigger = null;
  }
}

function closeSheets() {
  sheets().forEach((details) => { details.open = false; });
}

// 面板頂部說明文字預設收合為兩行，保留原節點位置（app.js 以 > .dialog-copy 直接子選擇器更新文字）
function enhanceHelpText() {
  dialog.querySelectorAll(".admin-panel > .dialog-copy").forEach((copy) => {
    if (copy.dataset.adminHelp) return;
    copy.dataset.adminHelp = "true";
    copy.classList.add("admin-help", "is-clamped");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "admin-help-toggle";
    toggle.dataset.adminHelpToggle = "";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "展開說明";
    copy.insertAdjacentElement("afterend", toggle);
    // 面板隱藏時無法量高度；顯示後（尺寸變動）才判斷是否真的被截斷
    new ResizeObserver(() => {
      if (!copy.classList.contains("is-clamped") || !copy.clientHeight) return;
      toggle.hidden = copy.scrollHeight <= copy.clientHeight + 1;
    }).observe(copy);
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
    if (event.target.closest("[data-admin-sheet-close]")) return closeSheets();
    const help = event.target.closest("[data-admin-help-toggle]");
    if (help) {
      const copy = help.previousElementSibling;
      const expanded = copy.classList.toggle("is-clamped") === false;
      help.setAttribute("aria-expanded", String(expanded));
      help.textContent = expanded ? "收合說明" : "展開說明";
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
  // 面板開啟時 Esc 只關閉面板，不關閉整個後台
  dialog.addEventListener("cancel", (event) => {
    if (!openSheet()) return;
    event.preventDefault();
    closeSheets();
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
