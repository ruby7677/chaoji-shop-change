// 結帳請求識別碼：同一份訂單內容的重送沿用同一個 key，資料庫會回傳原訂單而不是再建一筆（202610130001）。
// 結果不明（逾時、斷線、伺服器錯誤）時保留 key，重新整理同一分頁後仍可沿用；確定建單成功後先標記已完成，購物車保存後才清除。
// 已完成的 key 不再沿用：清除前中斷（重新整理、關閉分頁）時，之後相同內容的購買要換新 key，不能拿回舊訂單。
const STORAGE_KEY = "chaoji-checkout-request";
// 已完成後這段時間內再送出相同內容，先請客人確認是否真的要再下一筆
export const RECENT_COMPLETED_MS = 30 * 60 * 1000;
// 本頁最後一次寫入的狀態，優先於 sessionStorage：storage 可讀但寫不進去時，舊記錄不能蓋過本頁最新的 key。
// undefined＝本頁尚未寫入（重新整理後以 storage 為準）；null＝本頁已清除。
let memoryPending;

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
    if (!pending || typeof pending.key !== "string" || typeof pending.digest !== "string") return null;
    return { key: pending.key, digest: pending.digest, completedAt: typeof pending.completedAt === "number" ? pending.completedAt : null };
  } catch {
    return null;
  }
}

function currentPending(storage) {
  if (memoryPending !== undefined) return memoryPending;
  return storage ? readPending(storage) : null;
}

function writePending(storage, pending) {
  memoryPending = pending;
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(pending)); } catch { /* 無法保存時改由同頁記憶體沿用，只有重新整理後才換新 key */ }
}

/** 回傳這份請求內容要用的 key：內容與上次「尚未完成」的請求相同時沿用，否則產生新的。 */
export function checkoutRequestKey(body, { storage = sessionStore(), randomUUID = () => crypto.randomUUID() } = {}) {
  const digest = requestDigest(body);
  const pending = currentPending(storage);
  if (pending && pending.digest === digest && !pending.completedAt) return pending.key;
  const key = randomUUID();
  writePending(storage, { key, digest, completedAt: null });
  return key;
}

/** 收到建單成功（201）後立刻標記：之後即使來不及清除，這個 key 也不會再被沿用。 */
export function markCheckoutRequestCompleted({ storage = sessionStore(), now = Date.now() } = {}) {
  const pending = currentPending(storage);
  if (pending) writePending(storage, { ...pending, completedAt: now });
}

/** 相同內容是否剛在這個分頁建單成功（尚未清除且在 RECENT_COMPLETED_MS 內）。 */
export function recentCompletedCheckout(body, { storage = sessionStore(), now = Date.now() } = {}) {
  const pending = currentPending(storage);
  return Boolean(pending?.completedAt && pending.digest === requestDigest(body) && now - pending.completedAt < RECENT_COMPLETED_MS);
}

/** 建單成功後清除，下一次購買使用新的 key。 */
export function clearCheckoutRequestKey({ storage = sessionStore() } = {}) {
  memoryPending = null;
  try { storage?.removeItem(STORAGE_KEY); } catch { /* ignore restricted storage */ }
}
