// 有期限的 Promise 快取：同一世代內相同 key 只載入一次（失敗會移除、下次重試），世代超過 ttlMs 後整批作廢。
// 結帳的門市清單用它：頁面開著時後台發佈了新清單，最多 ttlMs 後就會重新載入，且索引與縣市檔永遠同一批換掉。
export function createExpiringCache(ttlMs, now = Date.now) {
  let startedAt = now();
  const entries = new Map();
  return {
    get(key, load) {
      if (now() - startedAt > ttlMs) {
        entries.clear();
        startedAt = now();
      }
      if (!entries.has(key)) entries.set(key, load().catch((error) => { entries.delete(key); throw error; }));
      return entries.get(key);
    }
  };
}
