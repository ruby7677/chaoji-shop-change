// 規格指定的商品圖片（後台「規格圖片」）：回傳它在商品頁圖庫中的位置；沒指定或圖庫沒有這張時回傳 -1（不移動）。
export function variantImageIndex(images, variant) {
  if (!variant?.image_id || !Array.isArray(images)) return -1;
  return images.findIndex((image) => image.id === variant.image_id);
}
