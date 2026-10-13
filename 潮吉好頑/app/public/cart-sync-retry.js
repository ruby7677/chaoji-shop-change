// 會員雲端購物車同步失敗後的重試排程：依退避時間重送，恢復連線或回到頁面時立即重試；成功或換會員時清除。
export const CART_SYNC_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];

/**
 * run：重送一次，失敗時呼叫端再呼叫 schedule()。
 * target：註冊 online／visibilitychange 的對象（預設 window），document 用來判斷頁面是否可見。
 */
export function createCartSyncRetry({ run, delays = CART_SYNC_RETRY_DELAYS_MS, target = globalThis.window ?? globalThis, doc = globalThis.document } = {}) {
  let timer = null;
  let attempt = 0;
  let waiting = false;

  const clearTimer = () => {
    if (timer) target.clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    if (!waiting) return;
    clearTimer();
    waiting = false;
    run();
  };
  const onVisible = () => { if (!doc || doc.visibilityState === "visible") fire(); };

  target?.addEventListener?.("online", fire);
  doc?.addEventListener?.("visibilitychange", onVisible);

  return {
    /** 同步失敗：排下一次重試，間隔逐次拉長到上限 */
    schedule() {
      clearTimer();
      waiting = true;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      timer = target.setTimeout(fire, delay);
    },
    /** 同步成功或換會員：取消等待中的重試並重設退避 */
    reset() {
      clearTimer();
      waiting = false;
      attempt = 0;
    },
    get pending() { return waiting; }
  };
}
