// 登入（或重新整理）時，本機購物車與會員雲端購物車的合併規則。
// 本機 sessionStorage 的購物車可能是：尚未登入時加入的訪客購物車，或已和某位會員同步過的快照。
// 只有訪客新增的部分要和雲端相加；把已同步的快照再相加一次，每次重新整理數量都會倍增。
// 判斷一律用 sessionStorage 裡「裁切前」的內容：庫存下降或下架造成的差異不算使用者修改。

const OWNER_KEY = "cj-cart-owner";

/** 轉成 [{ variant_id, quantity }]，合併同款、排除無效數量，依 variant_id 排序。 */
export function normalizeCartItems(items) {
  const totals = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const variantId = String(item?.variant_id ?? item?.id ?? "").toLowerCase();
    const quantity = Number(item?.quantity);
    if (!variantId || !Number.isInteger(quantity) || quantity < 1) continue;
    totals.set(variantId, (totals.get(variantId) || 0) + quantity);
  }
  return [...totals].sort(([left], [right]) => left.localeCompare(right)).map(([variant_id, quantity]) => ({ variant_id, quantity }));
}

const sameItems = (left, right) => JSON.stringify(normalizeCartItems(left)) === JSON.stringify(normalizeCartItems(right));

/**
 * 本機購物車最後一次與哪位會員同步（items），以及登入身分清除當下的購物車（guestBase，之後的增量才是訪客加入的）。
 * 沒有紀錄代表是訪客購物車。舊版只存 syncedHash（stableCartHash 的 JSON），解析成品項沿用。
 */
export function readCartOwner() {
  try {
    const owner = JSON.parse(sessionStorage.getItem(OWNER_KEY) || "null");
    if (!owner || typeof owner.userId !== "string") return null;
    const items = Array.isArray(owner.items) ? owner.items : typeof owner.syncedHash === "string" ? JSON.parse(owner.syncedHash) : null;
    if (!Array.isArray(items)) return null;
    return { userId: owner.userId, items, ...(Array.isArray(owner.guestBase) ? { guestBase: owner.guestBase } : {}) };
  } catch {
    return null;
  }
}

export function writeCartOwner(userId, items) {
  try { sessionStorage.setItem(OWNER_KEY, JSON.stringify({ userId, items: normalizeCartItems(items) })); } catch { /* restricted storage */ }
}

/** 登入身分被清除（登出或登入過期）時記下當下的購物車；之後多出來的部分才算訪客加入的商品。 */
export function markCartGuestStart(items) {
  const owner = readCartOwner();
  if (!owner || owner.guestBase) return;
  try { sessionStorage.setItem(OWNER_KEY, JSON.stringify({ ...owner, guestBase: normalizeCartItems(items) })); } catch { /* restricted storage */ }
}

/** sessionStorage 裡尚未經型錄裁切的本機購物車；無法讀取時回傳 null，由呼叫端改用記憶體中的購物車。 */
export function readStoredCartItems() {
  try {
    const stored = sessionStorage.getItem("cj-cart");
    return stored === null ? [] : normalizeCartItems(JSON.parse(stored));
  } catch {
    return null;
  }
}

/**
 * 決定登入後購物車由哪些品項組成；回傳的 local 與 remote 會相加，再交給呼叫端套用庫存限制。
 * - 本機與雲端相同：只用雲端。
 * - 訪客購物車（沒有同步紀錄）：本機 + 雲端。
 * - 同一位會員：本機與上次同步相同就用雲端，否則本機有未同步的修改，只用本機並重新上傳。
 * - 別位會員留下的快照：只帶入登入身分清除後多出來的部分（以訪客身分新加的商品）+ 雲端；
 *   沒有清除當下的紀錄時以那位會員最後同步的內容為基準。前一位會員未同步的修改不會帶入。
 */
export function planLoginCart({ owner, userId, localItems, remoteItems }) {
  const local = normalizeCartItems(localItems);
  const remote = normalizeCartItems(remoteItems);
  if (sameItems(local, remote)) return { local: [], remote };
  if (!owner) return { local, remote };
  if (owner.userId === userId) return sameItems(local, owner.items) ? { local: [], remote } : { local, remote: [] };
  const synced = new Map(normalizeCartItems(owner.guestBase ?? owner.items).map((item) => [item.variant_id, item.quantity]));
  const guestAdded = local
    .map((item) => ({ variant_id: item.variant_id, quantity: item.quantity - (synced.get(item.variant_id) || 0) }))
    .filter((item) => item.quantity > 0);
  return { local: guestAdded, remote };
}
