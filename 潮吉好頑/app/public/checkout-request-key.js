// 結帳請求識別碼：同一份訂單內容的重送沿用同一個 key，資料庫會回傳原訂單而不是再建一筆（202610130001）。
// 結果不明（逾時、斷線、伺服器錯誤）時保留 key，重新整理同一分頁後仍可沿用；確定建單成功後才清除。
const STORAGE_KEY = "chaoji-checkout-request";
// 同一頁的備援：sessionStorage 不可用（無痕、受限預覽）時，同頁重送仍沿用同一個 key
let memoryPending = null;

function sessionStore() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

// 只保存內容雜湊，不在瀏覽器留下收件人姓名、電話與地址；兩組 32 位元 FNV-1a 只用來判斷「內容是否相同」。
export function requestDigest(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16)}-${b.toString(16)}-${text.length}`;
}

function readPending(storage) {
  try {
    const pending = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    return pending && typeof pending.key === "string" && typeof pending.digest === "string" ? pending : null;
  } catch {
    return null;
  }
}

/** 回傳這份請求內容要用的 key：內容與上次未完成的請求相同時沿用，否則產生新的。 */
export function checkoutRequestKey(body, { storage = sessionStore(), randomUUID = () => crypto.randomUUID() } = {}) {
  const digest = requestDigest(body);
  const pending = (storage ? readPending(storage) : null) || memoryPending;
  if (pending && pending.digest === digest) return pending.key;
  const key = randomUUID();
  memoryPending = { key, digest };
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(memoryPending)); } catch { /* 無法保存時改由同頁記憶體沿用，只有重新整理後才換新 key */ }
  return key;
}

/** 建單成功後清除，下一次購買使用新的 key。 */
export function clearCheckoutRequestKey({ storage = sessionStore() } = {}) {
  memoryPending = null;
  try { storage?.removeItem(STORAGE_KEY); } catch { /* ignore restricted storage */ }
}
