// 內嵌執行設定：Worker 回傳首頁、商品頁與訂單頁時會把 /api/config 的內容寫在 HTML 最後
// （src/share-meta.ts 的 CONFIG_DATA_ID），開機直接讀取，不必等 /api/config 往返。
// 讀完就移除；之後再讀、沒有內嵌或內容損壞時回傳 null，由呼叫端照舊請求 /api/config。
export const CONFIG_DATA_ID = "cj-config-data";

export function takeEmbeddedConfig(doc = globalThis.document) {
  const node = doc?.getElementById(CONFIG_DATA_ID);
  if (!node) return null;
  node.remove();
  try {
    const config = JSON.parse(node.textContent);
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  }
}
