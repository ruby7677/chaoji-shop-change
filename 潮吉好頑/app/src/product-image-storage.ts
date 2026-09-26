// 商品圖片儲存與 edge cache 共用工具：私有 product-images bucket，由 Worker 代理讀取。
// index.ts（主圖）與 product-showcase.ts（多圖）共用，避免兩處檢查規則分歧。

export const PRODUCT_IMAGE_BUCKET = "product-images";
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// 上傳路由排除在全站 128KB JSON 上限之外，formData() 解析前必須先用 Content-Length
// 擋下明顯過大的請求：主圖 + 選填縮圖各最多 PRODUCT_IMAGE_MAX_BYTES，再加 multipart
// 框架與欄位本身的額外開銷。
export const PRODUCT_IMAGE_UPLOAD_MAX_REQUEST_BYTES = 2 * PRODUCT_IMAGE_MAX_BYTES + 256 * 1024;
export const PRODUCT_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

const PRODUCT_IMAGE_SIGNATURES: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]
};

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
};

export async function hasImageSignature(image: File, mimeType: string) {
  const signature = PRODUCT_IMAGE_SIGNATURES[mimeType];
  if (!signature) return false;
  const header = new Uint8Array(await image.slice(0, signature.length).arrayBuffer());
  return header.length === signature.length && signature.every((byte, index) => byte === 0 || header[index] === byte);
}

export function storageObjectUrl(env: { SUPABASE_URL?: string }, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}/${encodedPath}`;
}

export function imageContentType(path: string, fallback: string | null) {
  const imageType = Object.keys(PRODUCT_IMAGE_TYPES).find((type) => path.toLowerCase().endsWith(`.${PRODUCT_IMAGE_TYPES[type]}`));
  return imageType || fallback || "application/octet-stream";
}

// 縮圖固定存在主圖同一資料夾，副檔名固定 .thumb.webp，與主圖副檔名（jpg/png/webp）無關；
// 因此同一商品 id 下的縮圖路徑在更換主圖格式時維持不變，見 catalog.ts uploadProductImage 的清理邏輯。
export function thumbnailPathFor(imagePath: string): string {
  const lastSlash = imagePath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? imagePath.slice(0, lastSlash + 1) : "";
  const fileName = lastSlash >= 0 ? imagePath.slice(lastSlash + 1) : imagePath;
  const lastDot = fileName.lastIndexOf(".");
  const baseName = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
  return `${dir}${baseName}.thumb.webp`;
}

// Cache API 只存在處理請求的機房，cache.delete 無法清除其他機房；因此：
// 1. 快取 key 含版本（?v=），圖片變動後前台自動改用新網址，不依賴 purge；
// 2. 邊緣快取最多保留 1 天（s-maxage），已刪除或下架的圖片最遲 1 天在各機房失效；
// 3. 只有版本與資料庫一致時才寫入邊緣快取，舊版或亂填的 v 不會佔用快取。
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable, s-maxage=86400";
export const IMAGE_STALE_VERSION_CACHE_CONTROL = "public, max-age=60";

export function requestedImageVersion(request: Request) {
  return new URL(request.url).searchParams.get("v") || "";
}

export function productImageCacheKey(request: Request, productId: string, imageId: string | undefined, version: string, size?: string) {
  const url = new URL(request.url);
  url.pathname = imageId ? `/api/product-images/${productId}/${imageId}` : `/api/product-images/${productId}`;
  // size 併入 key 是 query string 的一部分，讓 size=thumb 與完整圖使用不同的邊緣快取項目。
  const params = new URLSearchParams({ v: version });
  if (size) params.set("size", size);
  url.search = `?${params.toString()}`;
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

export function productImageEdgeCache() {
  return (caches as unknown as { default: EdgeCache }).default;
}

// 只清除本機房（通常是管理員所在機房）的指定版本；其他機房靠版本 key 與 s-maxage 失效。
export async function purgeProductImageCache(request: Request, productId: string, imageId: string | undefined, version: string, size?: string) {
  await productImageEdgeCache().delete(productImageCacheKey(request, productId, imageId, version, size));
}
