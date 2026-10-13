// 觸控診斷（?cj_touch=1）的純函式：模式解析、觸控目標分類、事件紀錄整理與面板文字。DOM 操作在 touch-diagnostics.js。
export const TOUCH_PARAM = "cj_touch";
// 同一張卡同一目標在這段時間內再按，算「第 N 次」；成功 click 後重新從第 1 次算
export const RETRY_WINDOW_MS = 10000;

/** ?cj_touch=1 或 a：A 對照組（原版 CSS）；b：B 測試組；0：關閉。沒有參數時沿用分頁內已選的組別。 */
export function touchMode(param, stored) {
  if (param === "0") return null;
  if (param === "b" || param === "B") return "b";
  if (param !== null && param !== undefined) return "a";
  return stored === "a" || stored === "b" ? stored : null;
}

const KIND_SELECTORS = [
  ["加入購物車", "[data-add]"],
  ["直接購買", "[data-buy-now]"],
  ["選擇規格", "[data-choose-variant]"]
];

/**
 * 依命中元素與觸控座標分類。名稱連結以 ::after 延伸到整張卡，點圖片與名稱命中的都是同一個 <a>，
 * 所以改用座標落在圖片區或標題區判斷。rects 為 { image, title }（getBoundingClientRect 結果，可缺）。
 */
export function classifyTarget(target, point, rects = {}) {
  for (const [kind, selector] of KIND_SELECTORS) if (target?.closest?.(selector)) return kind;
  if (!target?.closest?.(".product-card")) return "其他";
  const inside = (rect) => rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  if (inside(rects.image)) return "圖片";
  if (inside(rects.title)) return "名稱";
  return "卡片其他";
}

/** 命中元素的簡短描述：標籤＋第一個 class（不含商品名稱等內容）。 */
export function describeElement(element) {
  if (!element?.tagName) return "?";
  const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : "";
  return className ? `${element.tagName}.${className}` : element.tagName;
}

/** 觸控前的捲動狀態：距最後一次 scroll 事件多久、之後是否收到 scrollend、手指按住期間有沒有捲動。只記錄事實，不用門檻判定。 */
export function scrollContext(downAt, scroll) {
  const sinceScroll = scroll.lastScrollAt === null ? null : Math.round(downAt - scroll.lastScrollAt);
  let ended = "不支援";
  if (scroll.scrollendSupported) ended = scroll.lastScrollAt === null ? "—" : (scroll.lastScrollEndAt !== null && scroll.lastScrollEndAt >= scroll.lastScrollAt ? "有" : "未收到");
  return { sinceScroll, ended };
}

/** 同一目標（卡片＋類別）在 RETRY_WINDOW_MS 內的第幾次觸控；上一筆成功 click 就重新從 1 算。 */
export function attemptNumber(records, key, downAt) {
  const previous = [...records].reverse().find((record) => record.key === key);
  if (!previous || previous.clicked || downAt - previous.downAt > RETRY_WINDOW_MS) return 1;
  return previous.attempt + 1;
}

const EVENT_SHORT = { pointerup: "up", pointercancel: "cancel", mouseover: "mo", mousedown: "md", mouseup: "mu", click: "ck", scroll: "捲" };

/** 一筆觸控兩行：結果與捲動狀態、各事件距 pointerdown 的毫秒數。 */
export function formatRecord(record) {
  const result = record.clicked ? `✓click${record.clickKind && record.clickKind !== record.kind ? `→${record.clickKind}` : ""}` : "✗無click";
  const since = record.sinceScroll === null ? "未捲動" : `距捲動${record.sinceScroll}ms`;
  const events = record.events.map(([type, dt]) => `${EVENT_SHORT[type] || type}${dt}`).join(" ");
  return [
    `#${record.id} ${record.variant.toUpperCase()} ${record.kind}${record.card ? `(卡${record.card})` : ""} 第${record.attempt}次 ${result}`,
    `  ${since} end:${record.ended}｜${record.target}｜${events || "—"}`
  ];
}
