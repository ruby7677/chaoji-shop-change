// 首頁 Hero 輪播：由型錄規格資料挑選商品並產生 slide 標記。
// 選品規則：後台有設定輪播排序、有照片、至少一個規格有可售量；
// 都沒有設定時，自動改用最新的有圖預購商品，避免首屏空白。
import { escapeHtml, isPreorderItem } from "./product-format.js";

const MAX_SLIDES = 12;
const FALLBACK_SLIDES = 5;
const INTRO_MAX = 90;
// 業主決定（2026-09-24）：輪播文字只做介紹，不放價格與庫存。沒有「新品／熱款」欄位，
// 依類型標示：預購＝新品預購、現貨＝熱門推薦（輪播商品本身即為業主挑選的精選）。
const FEATURE_LABELS = {
  preorder: { flag: "NEW", label: "新品預購", fallback: "新品搶先預購，到貨第一時間通知你。" },
  in_stock: { flag: "HOT", label: "熱門推薦", fallback: "店內人氣熱款，現貨直接帶回家。" }
};

// 介紹文字：優先用後台「輪播短語」，否則取商品說明第一段；過長時在字元邊界截斷
function introText(lead, preorder) {
  const source = String(lead.hero_tagline || lead.description || "").replace(/\s+/g, " ").trim();
  if (!source) return FEATURE_LABELS[preorder ? "preorder" : "in_stock"].fallback;
  const chars = [...source];
  return chars.length > INTRO_MAX ? `${chars.slice(0, INTRO_MAX).join("").trimEnd()}…` : source;
}

function groupByProduct(variants) {
  const groups = new Map();
  for (const variant of variants) {
    const key = variant.product_id || variant.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(variant);
  }
  return [...groups.values()];
}

function toSlide(variants) {
  const sellable = variants.filter((variant) => Number(variant.stock || 0) > 0);
  if (!sellable.length) return null;
  const lead = sellable[0];
  if (!lead.image_url) return null;
  const preorder = isPreorderItem(lead);
  return {
    variantId: lead.id,
    name: lead.product_name || lead.name,
    category: lead.category || "好頑選物",
    type: lead.type,
    preorder,
    intro: introText(lead, preorder),
    imageUrl: lead.image_url,
    rank: Number.isInteger(lead.hero_rank) ? lead.hero_rank : null,
    order: Number(lead.display_order || 0)
  };
}

export function selectHeroSlides(variants) {
  const slides = groupByProduct(variants || []).map(toSlide).filter(Boolean);
  const ranked = slides.filter((slide) => slide.rank !== null).sort((a, b) => a.rank - b.rank || a.order - b.order);
  if (ranked.length) return ranked.slice(0, MAX_SLIDES);
  return slides.filter((slide) => slide.preorder).sort((a, b) => a.order - b.order).slice(0, FALLBACK_SLIDES);
}

// 業主決定（2026-09-24）：拿掉黑色外框，商品圖直接放在黃底上放大；文字移到圖片下方，保留分層淡入上移。
// 圖片本身也可點進商品頁，但只給滑鼠／觸控用（tabindex=-1、aria-hidden），鍵盤與報讀器以下方按鈕為準。
function slideMarkup(slide, index, total) {
  // 第一張立即載入並提高優先度（首屏 LCP 與開機畫面等待的圖片），其餘延後載入。
  const loading = index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const id = escapeHtml(slide.variantId);
  const feature = FEATURE_LABELS[slide.preorder ? "preorder" : "in_stock"];
  return `<div class="hero-slide${index % 2 ? " hero-slide--alt" : ""}" role="group" aria-roledescription="slide" aria-label="${index + 1} / ${total}：${escapeHtml(slide.name)}" data-hero-slide="${index}">
<button type="button" class="hero-slide-link" data-detail="${id}" tabindex="-1" aria-hidden="true"><span class="hero-slide-media"><img src="${escapeHtml(slide.imageUrl)}" alt="" decoding="async" ${loading} /></span></button>
<div class="hero-slide-info"><p class="hero-slide-kicker" data-stagger><span class="hero-slide-flag${slide.preorder ? " hero-slide-flag--new" : ""}">${feature.flag}</span><span class="hero-slide-feature">${feature.label}</span><span class="hero-slide-category">${escapeHtml(slide.category)}</span></p><h2 class="hero-slide-name" data-stagger>${escapeHtml(slide.name)}</h2><p class="hero-slide-intro" data-stagger>${escapeHtml(slide.intro)}</p><button type="button" class="hero-slide-more" data-detail="${id}" data-stagger>查看商品<span class="sr-only">：${escapeHtml(slide.name)}</span><svg class="hero-slide-more-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>
</div>`;
}

function controlsMarkup(slides) {
  if (slides.length < 2) return "";
  const dots = slides.map((slide, index) => `<button type="button" class="hero-carousel-dot" data-hero-go="${index}" aria-label="第 ${index + 1} 個：${escapeHtml(slide.name)}"></button>`).join("");
  return `<div class="hero-carousel-controls"><button type="button" class="hero-carousel-arrow" data-hero-prev aria-label="上一個商品">‹</button><div class="hero-carousel-dots" role="group" aria-label="選擇輪播商品">${dots}</div><button type="button" class="hero-carousel-arrow" data-hero-next aria-label="下一個商品">›</button><button type="button" class="hero-carousel-toggle" data-hero-toggle aria-pressed="false" aria-label="暫停自動輪播"><span aria-hidden="true">❚❚</span></button></div>`;
}

export function heroCarouselMarkup(slides) {
  return `<div class="hero-carousel-track" aria-live="off">${slides.map((slide, index) => slideMarkup(slide, index, slides.length)).join("")}</div>${controlsMarkup(slides)}`;
}
