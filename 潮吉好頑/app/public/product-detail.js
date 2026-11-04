// 商品明細（/api/products/:id：介紹與多圖）：商品頁與快速選購面板共用同一份快取，成功的結果才保存。
const detailCache = new Map();

export function cachedProductDetail(productId) {
  return detailCache.get(productId) || null;
}

export async function loadProductDetail(productId) {
  if (detailCache.has(productId)) return detailCache.get(productId);
  try {
    const response = await fetch(`/api/products/${productId}`);
    const detail = response.ok ? await response.json() : { failed: true };
    if (response.ok) detailCache.set(productId, detail);
    return detail;
  } catch {
    return { failed: true };
  }
}

/** 規格指定的商品圖片（後台「規格圖片」）在明細中的資料；沒指定或明細尚未載入時回傳 null。 */
export function variantDetailImage(detail, variant) {
  if (!variant?.image_id || !Array.isArray(detail?.images)) return null;
  return detail.images.find((image) => image.id === variant.image_id) || null;
}
