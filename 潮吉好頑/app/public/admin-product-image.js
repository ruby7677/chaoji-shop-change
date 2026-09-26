// 後台商品主圖：格式與尺寸檢查、瀏覽器端縮圖轉 WebP、上傳，以及縮圖載入失敗時的替代內容。
import { adminFetch } from "./admin-app.js";

/** 建立後台商品主圖缺失或載入失敗時的可存取替代內容。 */
export function adminProductImageFallbackMarkup() {
  return '<span class="admin-product-placeholder" role="img" aria-label="尚無商品圖片"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5h16v11H4zM7 6.5l1.8-2h6.4l1.8 2M8 13l2.2-2.2 2.3 2.3 1.5-1.5 2 2"/></svg><small>NO IMAGE</small></span>';
}

/** 將後台商品縮圖的 404／解碼失敗畫面替換為一致的 fallback。 */
export function handleAdminProductImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const thumbnail = image.closest(".admin-product-thumbnail");
  if (!thumbnail || thumbnail.dataset.imageFallbackApplied === "true") return;
  thumbnail.dataset.imageFallbackApplied = "true";
  thumbnail.innerHTML = adminProductImageFallbackMarkup();
}

export function validateProductImage(file) {
  if (!file) return;
  if (!(file instanceof File)) throw new Error("請選擇商品照片");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("照片僅支援 JPG、PNG 或 WebP");
  if (file.size > 5 * 1024 * 1024) throw new Error("商品照片不可超過 5MB");
}

const PRODUCT_IMAGE_MAX_DIMENSION = 1600;
const PRODUCT_IMAGE_MAX_PIXELS = 40_000_000;
const PRODUCT_IMAGE_WEBP_QUALITY = 0.86;
const PRODUCT_THUMBNAIL_MAX_DIMENSION = 640;
const PRODUCT_THUMBNAIL_WEBP_QUALITY = 0.82;

async function decodeProductImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      try {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch {
        // Fall through to the Image element for browsers with partial ImageBitmap support.
      }
    }
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("圖片無法讀取"));
      image.src = objectUrl;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function productImageWebpName(name) {
  const baseName = String(name || "product-image").replace(/\.[^/.]+$/, "").trim() || "product-image";
  return `${baseName}.webp`;
}

function productThumbnailWebpName(name) {
  const baseName = String(name || "product-image").replace(/\.[^/.]+$/, "").trim() || "product-image";
  return `${baseName}.thumb.webp`;
}

// 用同一個已解碼來源畫第二張縮圖（最長邊 640px、不放大），只在主圖已成功轉成 WebP 時才呼叫；
// 任何一步失敗都回傳 null，讓呼叫端略過縮圖、只上傳主圖。
async function buildProductThumbnail(decoded, sourceName) {
  const longestSide = Math.max(decoded.width, decoded.height);
  if (longestSide <= PRODUCT_THUMBNAIL_MAX_DIMENSION) return null;
  const scale = PRODUCT_THUMBNAIL_MAX_DIMENSION / longestSide;
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  try {
    context.drawImage(decoded.source, 0, 0, width, height);
  } catch {
    return null;
  }
  let blob;
  try {
    blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("縮圖轉換失敗")), "image/webp", PRODUCT_THUMBNAIL_WEBP_QUALITY));
  } catch {
    return null;
  }
  if (!(blob instanceof Blob) || blob.type !== "image/webp") return null;
  try {
    return new File([blob], productThumbnailWebpName(sourceName), { type: "image/webp", lastModified: Date.now() });
  } catch {
    return null;
  }
}

export async function prepareProductImage(file) {
  if (!file) return null;
  validateProductImage(file);
  let decoded;
  try {
    decoded = await decodeProductImage(file);
  } catch {
    throw new Error("圖片無法讀取，請改用 JPG、PNG 或 WebP 圖片");
  }
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > PRODUCT_IMAGE_MAX_PIXELS) throw new Error("照片解析度過高，請先縮小圖片後再試");
    const scale = Math.min(1, PRODUCT_IMAGE_MAX_DIMENSION / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { file, converted: false, width: decoded.width, height: decoded.height };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    try {
      context.drawImage(decoded.source, 0, 0, width, height);
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
    let blob;
    try {
      blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("目前瀏覽器不支援 WebP 轉換")), "image/webp", PRODUCT_IMAGE_WEBP_QUALITY));
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
    if (!(blob instanceof Blob) || blob.type !== "image/webp" || blob.size > 5 * 1024 * 1024) return { file, converted: false, width: decoded.width, height: decoded.height };
    let preparedFile;
    try {
      preparedFile = new File([blob], productImageWebpName(file.name), { type: "image/webp", lastModified: Date.now() });
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
    // 縮圖用同一個已解碼來源產生；瀏覽器不支援 WebP 轉換時（上面已 return）不會走到這裡，符合「無法編碼就跳過縮圖」。
    const thumbnailFile = await buildProductThumbnail(decoded, file.name);
    return { file: preparedFile, thumbnailFile, converted: true, width, height };
  } finally {
    decoded.close();
  }
}

export async function uploadAdminProductImage(productId, file, thumbnailFile) {
  if (!file) return;
  validateProductImage(file);
  const formData = new FormData();
  formData.append("image", file, file.name);
  if (thumbnailFile instanceof File) formData.append("thumbnail", thumbnailFile, thumbnailFile.name);
  await adminFetch(`/api/admin/products/${productId}/image`, { method: "POST", body: formData });
}
