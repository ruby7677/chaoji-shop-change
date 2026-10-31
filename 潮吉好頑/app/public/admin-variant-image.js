// 規格編輯表單的「規格圖片」：從這件商品已上傳的多圖點選一張，前台商品頁切換到此規格時主圖跳到該張。
// 選「不指定」送 image_id: null（改用商品主圖）；欄位名稱 image_id 由 admin-catalog-panel.js 送出。
import { escapeHtml } from "./product-format.js";
import { adminGalleryImageSrc } from "./product-image-src.js";

const sortedImages = (product) => [...(product?.product_images || [])].sort((a, b) => a.sort_order - b.sort_order);

export function variantImageFieldMarkup(product, variant) {
  const images = sortedImages(product);
  if (!images.length) {
    return '<fieldset class="wide admin-variant-image"><legend>規格圖片（選填）</legend><small>請先在「照片與展示」分頁上傳多圖，才能指定此規格要顯示哪一張。</small></fieldset>';
  }
  // 指定的圖片已被刪除時（資料庫會自動清空，畫面可能尚未重新載入）視為不指定
  const selected = images.some((image) => image.id === variant.image_id) ? variant.image_id : "";
  const none = `<label class="admin-variant-image-option is-none"><input type="radio" name="image_id" value="" ${selected ? "" : "checked"} /><span>不指定<small>用商品主圖</small></span></label>`;
  const options = images.map((image, index) => `<label class="admin-variant-image-option"><input type="radio" name="image_id" value="${escapeHtml(image.id)}" ${image.id === selected ? "checked" : ""} /><img src="${escapeHtml(adminGalleryImageSrc(product.id, image))}" alt="第 ${index + 1} 張" loading="lazy" /></label>`).join("");
  return `<fieldset class="wide admin-variant-image"><legend>規格圖片（選填）</legend><div class="admin-variant-image-list">${none}${options}</div><small>前台選到此規格時，商品頁主圖會切換到這張。</small></fieldset>`;
}

/** 表單有規格圖片欄位時才送 image_id；優惠價面板等沒有此欄位的表單不帶，資料庫保留原值。 */
export function variantImagePayload(formData) {
  return formData.has("image_id") ? { image_id: String(formData.get("image_id") || "") || null } : {};
}
