// 觸控診斷模式（只在除錯時載入）：?cj_touch=1（A 對照組，原版 CSS）、?cj_touch=b（B 測試組）、?cj_touch=0 關閉。
// 記錄每次觸控的 pointerdown／pointerup／pointercancel、iOS 合成的 mouseover／mousedown／mouseup、click、命中元素，
// 以及觸控前後的 scroll／scrollend 時間。全部是 passive 的 capture 監聽：不攔截、不 preventDefault、不模擬 click。
// 不跳 alert 或 toast；左下角小按鈕開啟紀錄面板。B 組的 CSS 在 touch-diagnostics.css，只有診斷模式才載入。
import { TOUCH_PARAM, attemptNumber, classifyTarget, describeElement, formatRecord, scrollContext, touchMode } from "./touch-diagnostics-core.js";

const MODE_KEY = "cj-touch-diag";
const LOG_KEY = "cj-touch-log";
const MAX_RECORDS = 40;
// pointerup 後這段時間內的 click／mouse 事件仍算同一次觸控（iOS 合成 click 通常在 up 後數十毫秒內）
const SETTLE_MS = 1000;
const OPTIONS = { capture: true, passive: true };

function readMode() {
  try {
    const mode = touchMode(new URL(location.href).searchParams.get(TOUCH_PARAM), sessionStorage.getItem(MODE_KEY));
    if (mode) sessionStorage.setItem(MODE_KEY, mode);
    else { sessionStorage.removeItem(MODE_KEY); sessionStorage.removeItem(LOG_KEY); }
    return mode;
  } catch {
    return null;
  }
}

function readLog() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-MAX_RECORDS) : [];
  } catch {
    return [];
  }
}

let variant = readMode();
const records = variant ? readLog() : [];
let current = null;
const scroll = { lastScrollAt: null, lastScrollEndAt: null, scrollendSupported: "onscrollend" in window };
let panel = null;

function save() {
  try { sessionStorage.setItem(LOG_KEY, JSON.stringify(records.slice(-MAX_RECORDS))); } catch { /* 無法保存時只保留在記憶體 */ }
  if (panel && !panel.hidden) renderPanel();
}

function cardInfo(target) {
  const card = target?.closest?.(".product-card");
  if (!card) return { card: null, rects: {} };
  const index = [...(card.parentElement?.children || [])].indexOf(card) + 1;
  return {
    card: index || null,
    rects: { image: card.querySelector(".product-image")?.getBoundingClientRect(), title: card.querySelector("h3")?.getBoundingClientRect() }
  };
}

function insidePanel(event) {
  return event.target?.closest?.("[data-cj-touch-ui]");
}

function onPointerDown(event) {
  if (!event.isPrimary || insidePanel(event)) return;
  const downAt = event.timeStamp;
  const { card, rects } = cardInfo(event.target);
  const kind = classifyTarget(event.target, { x: event.clientX, y: event.clientY }, rects);
  const key = `${card || "-"}:${kind}`;
  current = {
    id: (records.at(-1)?.id || 0) + 1,
    variant,
    kind,
    card,
    key,
    attempt: attemptNumber(records, key, downAt),
    pointerType: event.pointerType,
    target: describeElement(event.target),
    downAt,
    upAt: null,
    clicked: false,
    clickKind: null,
    scrolledDuring: false,
    events: [],
    ...scrollContext(downAt, scroll)
  };
  records.push(current);
  save();
}

function addEvent(event) {
  if (!current || insidePanel(event)) return;
  if (current.upAt !== null && event.timeStamp - current.upAt > SETTLE_MS) return;
  current.events.push([event.type, Math.round(event.timeStamp - current.downAt)]);
  if (event.type === "pointerup" || event.type === "pointercancel") current.upAt = event.timeStamp;
  if (event.type === "click") {
    current.clicked = true;
    const { rects } = cardInfo(event.target);
    current.clickKind = classifyTarget(event.target, { x: event.clientX, y: event.clientY }, rects);
  }
  save();
}

function onScroll(event) {
  scroll.lastScrollAt = event.timeStamp;
  // 手指按住期間的捲動只記第一次，避免紀錄被大量 scroll 事件塞滿
  if (current && current.upAt === null && !current.scrolledDuring) {
    current.scrolledDuring = true;
    current.events.push(["scroll", Math.round(event.timeStamp - current.downAt)]);
    save();
  }
}

function applyVariant() {
  document.documentElement.classList.toggle("cj-touch-b", variant === "b");
  const fab = document.querySelector("[data-cj-touch-fab]");
  if (fab) fab.textContent = `觸控${variant.toUpperCase()}`;
}

function setVariant(next) {
  variant = next;
  try { sessionStorage.setItem(MODE_KEY, variant); } catch { /* 只影響重新整理後的組別 */ }
  applyVariant();
  renderPanel();
}

function renderPanel() {
  if (!panel) return;
  const hover = matchMedia("(hover: hover) and (pointer: fine)").matches ? "hover:fine" : "hover:none/coarse";
  const header = `觸控診斷 ${variant.toUpperCase()} 組｜${hover}｜scrollend ${scroll.scrollendSupported ? "支援" : "不支援"}`;
  const lines = records.slice(-8).flatMap(formatRecord);
  panel.querySelector("[data-cj-touch-log]").textContent = [header, ...lines].join("\n") || header;
}

function button(label, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function mountUi() {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/touch-diagnostics.css";
  document.head.append(stylesheet);

  const fab = button("", () => { panel.hidden = !panel.hidden; renderPanel(); });
  fab.className = "cj-touch-fab";
  fab.dataset.cjTouchUi = "";
  fab.dataset.cjTouchFab = "";

  panel = document.createElement("section");
  panel.className = "cj-touch-panel";
  panel.dataset.cjTouchUi = "";
  panel.hidden = true;
  const log = document.createElement("pre");
  log.dataset.cjTouchLog = "";
  const actions = document.createElement("div");
  actions.className = "cj-touch-actions";
  actions.append(
    button("A 組（原版）", () => setVariant("a")),
    button("B 組（測試）", () => setVariant("b")),
    button("清除", () => { records.length = 0; current = null; save(); renderPanel(); }),
    button("關閉", () => { panel.hidden = true; })
  );
  panel.append(actions, log);
  document.body.append(fab, panel);
  applyVariant();
}

if (variant) {
  for (const type of ["pointerup", "pointercancel", "mouseover", "mousedown", "mouseup", "click"]) document.addEventListener(type, addEvent, OPTIONS);
  document.addEventListener("pointerdown", onPointerDown, OPTIONS);
  document.addEventListener("scroll", onScroll, OPTIONS);
  document.addEventListener("scrollend", (event) => { scroll.lastScrollEndAt = event.timeStamp; }, OPTIONS);
  mountUi();
}
