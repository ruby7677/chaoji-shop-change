// 後台商品圖片網址：設定 R2 公開網域（/api/config 的 imageBaseUrl）時直接讀 R2，未上架商品也能預覽；
// 未設定時走 Worker 路由（只供已上架商品）。路徑規則與 src/product-image-urls.ts 相同。
import { auth } from "./app-core.js";

function encodedKey(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

// 與 src/product-image-storage.ts 的 thumbnailPathFor 相同：同資料夾、去掉副檔名加 .thumb.webp
export function thumbnailKeyFor(key) {
  const slash = key.lastIndexOf("/");
  const dir = key.slice(0, slash + 1);
  const name = key.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return `${dir}${dot > 0 ? name.slice(0, dot) : name}.thumb.webp`;
}

/** 商品主圖（thumb 為 true 時給縮圖）；沒有照片回空字串。 */
export function adminPrimaryImageSrc(product, { thumb = false } = {}, base = auth.config?.imageBaseUrl) {
  if (!product?.image_path) return "";
  const version = encodeURIComponent(product.image_updated_at || "1");
  if (base) return `${base}/${encodedKey(thumb ? thumbnailKeyFor(product.image_path) : product.image_path)}?v=${version}`;
  return `/api/product-images/${product.id}?v=${version}${thumb ? "&size=thumb" : ""}`;
}

/** 多圖預覽（後台用縮圖）。 */
export function adminGalleryImageSrc(productId, image, base = auth.config?.imageBaseUrl) {
  const version = encodeURIComponent(image.updated_at || "1");
  if (base && image.storage_path) return `${base}/${encodedKey(thumbnailKeyFor(image.storage_path))}?v=${version}`;
  return `/api/product-images/${productId}/${image.id}?v=${version}`;
}
