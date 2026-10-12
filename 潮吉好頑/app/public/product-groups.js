// 同一商品的多個規格在首頁商品格與推薦區合併成一張卡（庫存、購物車仍以規格為單位）。
// 卡片以「代表規格」的 id 進入商品頁：有庫存的第一個規格，都沒有庫存時取第一個。

/** 依原順序把規格分組成商品卡；只有一個規格的商品維持原樣。 */
export function groupProductCards(variants) {
  const groups = new Map();
  for (const variant of variants) {
    const key = variant.product_id || `variant:${variant.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(variant);
  }
  return [...groups.values()].map(productCardFromVariants);
}

/** 多規格商品卡：商品名稱、最低價（價格顯示「起」）、各規格庫存合計。 */
export function productCardFromVariants(variants) {
  const lead = variants.find((variant) => Number(variant.stock) > 0) || variants[0];
  if (variants.length < 2) return lead;
  const prices = variants.map((variant) => Number(variant.price || 0));
  return {
    ...lead,
    name: lead.product_name || lead.name,
    price: Math.min(...prices),
    // 多規格不顯示單一規格的原價，避免「原價 → 最低價」被誤讀成同一規格的折扣
    compare_at_price: null,
    stock: variants.reduce((sum, variant) => sum + Math.max(Number(variant.stock) || 0, 0), 0),
    variant_count: variants.length,
    price_varies: new Set(prices).size > 1
  };
}
