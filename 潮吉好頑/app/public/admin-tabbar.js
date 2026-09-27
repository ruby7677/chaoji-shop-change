// 手機底部分頁列：概況／訂單／商品＋「更多」（開啟既有側欄抽屜）。只在窄螢幕由 admin-shell.css 顯示；
// 分頁切換沿用側欄 [data-admin-tab] 按鈕的點擊流程，本模組不重複實作載入邏輯。
import { adminIcon } from "./admin-icons.js";

const PRIMARY_TABS = [
  ["overview", "chart", "概況"],
  ["orders", "receipt", "訂單"],
  ["products", "layers", "商品"]
];

// 目前分頁不在主要三項時，由「更多」顯示為使用中
export function tabbarActiveKey(tab) {
  return PRIMARY_TABS.some(([key]) => key === tab) ? tab : "more";
}

function badge(tab) {
  return `<span class="admin-nav-count hidden" data-admin-count="${tab}"></span>`;
}

// onOpenMore：開啟側欄抽屜；回傳 sync(tab) 供外殼在分頁變動時更新狀態
export function buildAdminTabbar(shell, { onOpenMore }) {
  if (typeof onOpenMore !== "function") throw new Error("buildAdminTabbar 需要 onOpenMore");
  const bar = document.createElement("nav");
  bar.className = "admin-tabbar";
  bar.setAttribute("aria-label", "後台主要分頁");
  bar.innerHTML = PRIMARY_TABS.map(([tab, icon, label]) => `<button type="button" data-admin-tabbar="${tab}">${adminIcon(icon)}<span>${label}</span>${tab === "orders" ? badge("orders") : ""}</button>`).join("")
    // 「更多」的徽章沿用側欄的低庫存數，提醒抽屜內有待處理項目
    + `<button type="button" data-admin-tabbar="more" aria-haspopup="dialog">${adminIcon("menu")}<span>更多</span>${badge("inventory")}</button>`;
  bar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-admin-tabbar]");
    if (!button) return;
    const key = button.dataset.adminTabbar;
    if (key === "more") return onOpenMore();
    const target = shell.querySelector(`.admin-nav [data-admin-tab="${key}"]`);
    if (!target) throw new Error(`找不到後台分頁：${key}`);
    target.click();
  });
  shell.append(bar);
  return function sync(tab) {
    const active = tabbarActiveKey(tab);
    bar.querySelectorAll("[data-admin-tabbar]").forEach((button) => {
      const current = button.dataset.adminTabbar === active;
      button.classList.toggle("active", current);
      if (current && active !== "more") button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  };
}
