// 電腦版「管理後台」另開新分頁（網址 /admin）；手機 Safari、LINE App 與平板維持同頁全螢幕視窗（業主決定 2026-09-24）。
// 登入資料存在各分頁獨立的 sessionStorage：同源 window.open（不加 noopener）會複製一份到新分頁，
// 新分頁因此沿用目前登入；若瀏覽器未複製（被阻擋或設定不同），/admin 會提示登入，登入後回到 /admin 自動開啟後台。
const ADMIN_PATH = "/admin";
let deps = null;
let adminTab = null;

export const isAdminRoute = () => location.pathname === ADMIN_PATH;

function prefersNewTab() {
  return window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 1024px)").matches && !deps.isLiffClient();
}

// 回傳 true 代表已在新分頁處理；false 時由呼叫端照舊在同頁開啟
export function openAdminInNewTab() {
  if (!deps || !prefersNewTab() || isAdminRoute()) return false;
  if (adminTab && !adminTab.closed) {
    adminTab.focus();
    return true;
  }
  const opened = window.open(ADMIN_PATH, "_blank");
  if (!opened) return false; // 快顯視窗被封鎖時改在同頁開啟
  adminTab = opened;
  return true;
}

// 開機流程（商品與會員狀態都載入後）呼叫：直接打開 /admin 時自動開啟後台
export function openAdminFromRoute() {
  if (!deps || !isAdminRoute()) return;
  if (!deps.isLoggedIn()) {
    deps.showToast("請先以管理員的 LINE 帳號登入，登入後會自動開啟後台", "warning");
    return;
  }
  if (!deps.isAdmin()) {
    history.replaceState(history.state, "", "/");
    deps.showToast("僅限管理員使用", "error");
    return;
  }
  deps.openAdmin();
}

// deps：isLiffClient、isLoggedIn、isAdmin、openAdmin、showToast
export function initAdminTab(options) {
  if (deps) return;
  deps = options;
  if (isAdminRoute()) document.title = `後台｜${document.title}`;
}
