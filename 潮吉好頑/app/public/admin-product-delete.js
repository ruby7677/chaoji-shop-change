// 後台刪除商品：編輯面板「刪除商品」按鈕（admin-products-forms.js deleteSectionMarkup）。
// 刪除＝封存（DELETE /api/admin/products/:id）：下架並從後台隱藏，訂單紀錄保留；重新載入後編輯面板因找不到商品而自動關閉。
import { showToast } from "./app-core.js";
import { adminFetch, invalidateAdminManagementOptions, refreshAdminSections } from "./admin-app.js";
import { adminConfirm } from "./admin-confirm.js";

async function deleteProduct(button) {
  const productId = button.dataset.productDelete;
  const name = button.dataset.productName || "此商品";
  const confirmed = await adminConfirm({
    title: `刪除「${name}」？`,
    message: ["商品與所有規格會從前台與後台移除，會員購物車內的此商品也會一併移除。", "已成立的訂單紀錄會保留；還有未完成訂單時無法刪除。"],
    confirmLabel: "刪除商品",
    danger: true,
    trigger: button
  });
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = "刪除中…";
  try {
    await adminFetch(`/api/admin/products/${productId}`, { method: "DELETE" });
  } catch (error) {
    button.disabled = false;
    button.textContent = "刪除商品";
    showToast(error.message || "刪除商品失敗", "error");
    return;
  }
  invalidateAdminManagementOptions();
  await refreshAdminSections(["products", "inventory", "overview"]);
  showToast(`已刪除「${name}」`, "success");
}

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-product-delete]") : null;
  if (button instanceof HTMLButtonElement && !button.disabled) void deleteProduct(button);
});
