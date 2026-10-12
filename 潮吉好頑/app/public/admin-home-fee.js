// 後台現貨宅配待付款：確認運費並以 LINE 通知客人含運總額（付款期限從儲存時重新計算 24 小時）。
// 客人收到通知才匯款，所以這裡只填運費，入帳與末五碼仍在回報匯款後確認。
import { escapeHtml } from "./product-format.js";
import { homeFeeConfirmed } from "./home-fee-state.js";

export function mountStockHomeFeeForm(card, order, insertBefore) {
  const confirmed = homeFeeConfirmed(order);
  if (!confirmed) {
    const statusChip = card.querySelector(".status-chip");
    if (statusChip) statusChip.textContent = "待填運費";
    card.classList.add("home-fee-pending");
  }
  const form = document.createElement("form");
  form.className = "admin-fulfillment-form";
  form.dataset.adminFulfillmentForm = order.id;
  const hint = confirmed
    ? "已通知客人；修改後會再通知一次，並重新計算 24 小時付款期限。"
    : "儲存後以 LINE 通知客人商品＋運費總額，付款期限從儲存時重新計算 24 小時；免運請填 0。";
  form.innerHTML = `<div class="form-grid"><label>實際運費<input name="shipping_fee" type="number" min="0" step="1" inputmode="numeric" value="${confirmed ? Number(order.shipping_fee || 0) : ""}" required /><small>${hint}</small></label><label class="wide">收款備註<textarea name="note" rows="2" maxlength="1000" placeholder="例如：宅配箱型、運費計算方式">${escapeHtml(order.admin_note || "")}</textarea></label></div><button class="primary-button" type="submit">${confirmed ? "更新運費並重新通知" : "確認運費並通知客人"}</button>`;
  card.insertBefore(form, insertBefore);
}
