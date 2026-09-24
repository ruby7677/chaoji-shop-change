// 首頁 Hero 輪播行為：交叉淡化切換、文字分層淡入上移、自動播放與暫停、滑動、鍵盤、無障礙。
// 動畫本身全在 CSS（.hero-slide.is-active）；這裡只切換 class 與設定 --stagger-i（CSP 允許 CSSOM）。
import { heroCarouselMarkup } from "./hero-slides.js";

const INTERVAL_MS = 5500;
const SWIPE_THRESHOLD_PX = 40;

export function mountHeroCarousel(root, slides) {
  const abort = new AbortController();
  const { signal } = abort;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.classList.add("hero-carousel");
  root.setAttribute("role", "region");
  root.setAttribute("aria-roledescription", "carousel");
  root.setAttribute("aria-label", "精選商品輪播");
  root.innerHTML = heroCarouselMarkup(slides);

  const slideNodes = [...root.querySelectorAll("[data-hero-slide]")];
  const dots = [...root.querySelectorAll("[data-hero-go]")];
  const toggle = root.querySelector("[data-hero-toggle]");
  const multiple = slideNodes.length > 1;
  let index = -1;
  let timer = 0;
  let hovering = false;
  let focused = false;
  // 使用者按下暫停，或系統要求減少動態時，不自動播放（WCAG 2.2.2）。
  let userPaused = reducedMotion;

  slideNodes.forEach((slide) => {
    slide.querySelectorAll("[data-stagger]").forEach((node, order) => node.style.setProperty("--stagger-i", String(order)));
    slide.inert = true;
  });

  function canAutoplay() {
    return multiple && !userPaused && !hovering && !focused && !document.hidden;
  }

  function schedule() {
    window.clearTimeout(timer);
    if (canAutoplay()) timer = window.setTimeout(() => goTo(index + 1), INTERVAL_MS);
  }

  function goTo(next) {
    const target = (next + slideNodes.length) % slideNodes.length;
    if (target === index) return schedule();
    slideNodes[index]?.classList.remove("is-active");
    if (slideNodes[index]) slideNodes[index].inert = true;
    index = target;
    slideNodes[index].classList.add("is-active");
    slideNodes[index].inert = false;
    dots.forEach((dot, dotIndex) => dot.setAttribute("aria-current", dotIndex === index ? "true" : "false"));
    schedule();
  }

  function syncToggle() {
    if (!toggle) return;
    toggle.setAttribute("aria-pressed", String(userPaused));
    toggle.setAttribute("aria-label", userPaused ? "開始自動輪播" : "暫停自動輪播");
    toggle.firstElementChild.textContent = userPaused ? "▶" : "❚❚";
  }

  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-hero-prev]")) goTo(index - 1);
    else if (event.target.closest("[data-hero-next]")) goTo(index + 1);
    else if (event.target.closest("[data-hero-go]")) goTo(Number(event.target.closest("[data-hero-go]").dataset.heroGo));
    else if (event.target.closest("[data-hero-toggle]")) { userPaused = !userPaused; syncToggle(); schedule(); }
  }, { signal });

  root.addEventListener("keydown", (event) => {
    if (!multiple || event.target.closest("input, textarea, select")) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); goTo(index - 1); }
    if (event.key === "ArrowRight") { event.preventDefault(); goTo(index + 1); }
  }, { signal });

  root.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") { hovering = true; schedule(); } }, { signal });
  root.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") { hovering = false; schedule(); } }, { signal });
  root.addEventListener("focusin", () => { focused = true; schedule(); }, { signal });
  root.addEventListener("focusout", (event) => { if (!root.contains(event.relatedTarget)) { focused = false; schedule(); } }, { signal });
  document.addEventListener("visibilitychange", schedule, { signal });

  // 水平滑動切換；垂直位移較大時視為捲動頁面，不攔截。
  let start = null;
  const track = root.querySelector(".hero-carousel-track");
  track.addEventListener("pointerdown", (event) => { start = { x: event.clientX, y: event.clientY }; }, { signal });
  track.addEventListener("pointerup", (event) => {
    if (!start || !multiple) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) goTo(index + (dx < 0 ? 1 : -1));
  }, { signal });
  track.addEventListener("pointercancel", () => { start = null; }, { signal });

  syncToggle();

  // 開機畫面結束後才播放第一張的進場動畫，否則動畫會在遮罩底下跑完。
  const activateFirst = () => window.requestAnimationFrame(() => window.requestAnimationFrame(() => goTo(0)));
  let observer = null;
  if (document.body.classList.contains("auth-boot-ready")) activateFirst();
  else {
    observer = new MutationObserver(() => {
      if (!document.body.classList.contains("auth-boot-ready")) return;
      observer.disconnect();
      observer = null;
      activateFirst();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  return {
    destroy() {
      abort.abort();
      observer?.disconnect();
      window.clearTimeout(timer);
    }
  };
}
