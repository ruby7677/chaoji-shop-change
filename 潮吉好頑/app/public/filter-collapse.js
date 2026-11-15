// 手機版系列篩選：按鈕自動換行，預設只顯示前兩列，最後放「＋更多 N 個系列」展開全部（再按一次收合）。
// 讓客人不用橫滑就知道還有其他系列；桌機（> 760px）不收合。展開狀態在重新渲染（搜尋、切換系列）時保留。
const MOBILE_QUERY = "(max-width: 760px)";
const MAX_ROWS = 2;

let expanded = false;
let wired = false;

// 依各按鈕的 offsetTop 算出前 maxRows 列共有幾顆（同一列的 top 相同；容許 2px 誤差）
export function chipsInFirstRows(tops, maxRows = MAX_ROWS) {
  const rows = [];
  let count = 0;
  for (const top of tops) {
    if (!rows.some((rowTop) => Math.abs(rowTop - top) <= 2)) {
      if (rows.length >= maxRows) break;
      rows.push(top);
    }
    count += 1;
  }
  return count;
}

// 只有寬度改變才需要重算換行。iPhone（Safari／LINE LIFF）捲動時工具列收合只改高度也會觸發 resize，
// 若每次都重排，手指正要點的按鈕會在觸控中途被重建或重新顯示，WebKit 就不送出 click（要點第二次）。
export function widthChanged(previousWidth, width) {
  return Number.isFinite(width) && width !== previousWidth;
}

export function moreLabel(hiddenCount) {
  return `＋更多 ${hiddenCount} 個系列`;
}

function isMobile() {
  return typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches;
}

function toggleButton(row) {
  let button = row.querySelector("[data-filter-more]");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "filter filter-more";
    button.dataset.filterMore = "";
    row.append(button);
  }
  button.hidden = false;
  return button;
}

function hideFrom(chips, index) {
  chips.forEach((chip, position) => { chip.hidden = position >= index; });
}

export function collapseFilterRow(row) {
  if (!row) return;
  wire(row);
  const chips = [...row.querySelectorAll(".filter[data-category]")];
  chips.forEach((chip) => { chip.hidden = false; });
  // 「更多」按鈕只隱藏、不移除重建：重算時維持同一個元素，進行中的點擊不會落空
  const existingMore = row.querySelector("[data-filter-more]");
  if (existingMore) existingMore.hidden = true;
  if (!isMobile()) return;

  const fitting = chipsInFirstRows(chips.map((chip) => chip.offsetTop));
  if (fitting >= chips.length) return;
  const activeIndex = chips.findIndex((chip) => chip.classList.contains("active"));
  // 選中的系列在收合區時維持全部顯示且不給「收合」，避免選中的按鈕被藏起來；改選前兩列的系列後才恢復收合
  if (activeIndex >= fitting) return;
  const button = toggleButton(row);
  if (expanded) {
    button.textContent = "收合系列";
    button.setAttribute("aria-expanded", "true");
    return;
  }
  // 「更多」按鈕本身也要擠在前兩列內：放不下就再多藏一顆
  let visible = fitting;
  button.setAttribute("aria-expanded", "false");
  do {
    hideFrom(chips, visible);
    button.textContent = moreLabel(chips.length - visible);
    const tops = [...chips.slice(0, visible), button].map((element) => element.offsetTop);
    if (chipsInFirstRows(tops) > visible) break;
    visible -= 1;
  } while (visible > Math.max(1, activeIndex + 1));
}

function wire(row) {
  if (wired) return;
  wired = true;
  row.addEventListener("click", (event) => {
    if (!event.target.closest("[data-filter-more]")) return;
    expanded = row.querySelector("[data-filter-more]")?.getAttribute("aria-expanded") !== "true";
    collapseFilterRow(row);
  });
  // 旋轉或改變視窗寬度時重新計算哪些按鈕要收起來
  let timer = 0;
  let lastWidth = window.innerWidth;
  const recalc = () => {
    if (!widthChanged(lastWidth, window.innerWidth)) return;
    lastWidth = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(() => collapseFilterRow(row), 120);
  };
  window.addEventListener("resize", recalc);
}
