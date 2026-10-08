// 首頁輪播：型錄有主圖寬高時，照片框帶上比例（手機版先保留空間，避免照片載入後版面跳動）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { heroCarouselMarkup, selectHeroSlides } from "../../public/hero-slides.js";

const variant = (overrides) => ({ id: "v1", product_id: "p1", product_name: "測試", stock: 2, type: "現貨", image_url: "/api/product-images/p1?v=1", hero_rank: 1, display_order: 0, ...overrides });

test("a slide with known image size carries its ratio on the photo frame", () => {
  const markup = heroCarouselMarkup(selectHeroSlides([variant({ image_width: 750, image_height: 1000 })]));
  assert.match(markup, /<span class="hero-slide-media" data-hero-ratio="0\.7500">/);
});

test("a slide without image size keeps the frame sized by the loaded photo", () => {
  const markup = heroCarouselMarkup(selectHeroSlides([variant({})]));
  assert.match(markup, /<span class="hero-slide-media">/);
  assert.doesNotMatch(markup, /data-hero-ratio/);
});
