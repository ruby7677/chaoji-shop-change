// 後台「預購叫貨」分頁：各預購規格已付款、待付款與已到貨的訂購件數，供決定向上游叫多少貨。
// 數字由 /api/admin/preorder-demand 依訂單明細統計（不看庫存異動，因為待付款訂單只保留、尚未扣庫存）。
import { adminFetch, adminTabHooks } from "./admin-app.js";
import { escapeHtml } from "./product-format.js";
import { preorderDemandHtml } from "./admin-preorder-demand-view.js";

function render(html) {
  const root = document.querySelector("#admin-preorder-demand-body");
  if (root) root.innerHTML = html;
}

async function load() {
  render('<p class="cvs-admin-note">載入中…</p>');
  try {
    const result = await adminFetch("/api/admin/preorder-demand");
    render(preorderDemandHtml(result.preorderDemand));
  } catch (error) {
    render(`<p class="form-error">${escapeHtml(error.message)}</p>`);
  }
}

adminTabHooks.set("preorder-demand", load);
