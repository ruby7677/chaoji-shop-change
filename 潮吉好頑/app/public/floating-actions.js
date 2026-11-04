// 首頁右下角浮動按鈕：LINE 客服連結固定顯示（在 index.html），「回到頂端」捲動超過一小段後才出現。
const SHOW_AFTER_PX = 400;

export const scrollTopHidden = (scrollY) => !(Number(scrollY) >= SHOW_AFTER_PX);

export function initFloatingActions(root = document, win = window) {
  const button = root.querySelector("[data-scroll-top]");
  if (!button) return;
  let queued = false;
  const update = () => { queued = false; button.hidden = scrollTopHidden(win.scrollY); };
  win.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(update);
  }, { passive: true });
  button.addEventListener("click", () => {
    const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    win.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });
  update();
}

if (typeof document !== "undefined" && typeof window !== "undefined") initFloatingActions();
