// 登入（或重新整理）時，本機購物車與會員雲端購物車的合併規則。
// 本機 sessionStorage 的購物車可能是：尚未登入時加入的訪客購物車，或已和某位會員同步過的快照。
// 只有訪客購物車要和雲端相加；把已同步的快照再相加一次，每次重新整理數量都會倍增。

const OWNER_KEY = "cj-cart-owner";

/** 本機購物車最後一次與哪位會員同步，以及當時的內容雜湊；沒有紀錄代表是訪客購物車。 */
export function readCartOwner() {
  try {
    const owner = JSON.parse(sessionStorage.getItem(OWNER_KEY) || "null");
    return owner && typeof owner.userId === "string" && typeof owner.syncedHash === "string" ? owner : null;
  } catch {
    return null;
  }
}

export function writeCartOwner(userId, syncedHash) {
  try { sessionStorage.setItem(OWNER_KEY, JSON.stringify({ userId, syncedHash })); } catch { /* restricted storage */ }
}

/**
 * - "merge"：訪客購物車，與雲端數量相加。
 * - "remote"：同一位會員且本機沒有未同步的修改，或是別位會員留下的快照，以雲端為準。
 * - "local"：同一位會員但本機有尚未同步成功的修改，以本機為準並重新上傳。
 */
export function cartLoginStrategy({ owner, userId, localHash, remoteHash }) {
  // 與雲端完全相同的本機購物車（例如部署前就同步過、還沒有標記的分頁）不再相加
  if (localHash === remoteHash) return "remote";
  if (!owner) return "merge";
  if (owner.userId !== userId) return "remote";
  return localHash === owner.syncedHash ? "remote" : "local";
}
