// 商品圖片網址。IMAGE_BASE_URL（R2 公開網域，例如 https://img.767780.xyz）設定後，型錄、商品頁與分享預覽
// 直接使用 R2 網址，圖片請求不經過 Worker；未設定時維持 Worker 路由 /api/product-images/...（由 Worker 讀 R2／Supabase）。
// 每次上傳都是新檔名，?v= 只是保險：舊網址與新網址永遠不會指向不同內容。
import { thumbnailPathFor } from "./product-image-storage";

type ImageUrlEnv = { IMAGE_BASE_URL?: string };

function imageBase(env: ImageUrlEnv) {
  return (env.IMAGE_BASE_URL || "").trim().replace(/\/+$/, "");
}

function objectUrl(base: string, key: string, version: string) {
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}?v=${encodeURIComponent(version)}`;
}

export type PrimaryImageUrls = { image_url: string; thumb_url: string };

/** 商品主圖與縮圖網址；imagePath 為空（沒有照片）時回 null。 */
export function primaryImageUrls(env: ImageUrlEnv, productId: string, imagePath: string | null | undefined, imageUpdatedAt: string | null | undefined): PrimaryImageUrls | null {
  if (!imagePath) return null;
  const version = imageUpdatedAt || "1";
  const base = imageBase(env);
  if (base) return { image_url: objectUrl(base, imagePath, version), thumb_url: objectUrl(base, thumbnailPathFor(imagePath), version) };
  const legacy = `/api/product-images/${productId}?v=${encodeURIComponent(version)}`;
  return { image_url: legacy, thumb_url: `${legacy}&size=thumb` };
}

/** 商品頁多圖的完整圖網址。 */
export function galleryImageUrl(env: ImageUrlEnv, productId: string, image: { id: string; storage_path: string; updated_at: string }) {
  const base = imageBase(env);
  if (base) return objectUrl(base, image.storage_path, image.updated_at);
  return `/api/product-images/${productId}/${image.id}?v=${encodeURIComponent(image.updated_at)}`;
}

/** 首頁要預先連線的圖片網域（未使用 R2 公開網域時不需要）。 */
export function imageOrigin(env: ImageUrlEnv) {
  const base = imageBase(env);
  try { return base ? new URL(base).origin : null; }
  catch { return null; }
}
