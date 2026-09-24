# 商品展示升級規劃書：Hero 預購輪播 × 商品頁多圖 × 詳細介紹 × 推薦商品

> 建立日期：2026-09-23｜參考來源：<https://kytoyscollection.easy.co>（EasyStore Dawn 系主題）
> 本文件是規劃，不代表已實作或已部署。實作依 `../AGENTS.md` 的分工、檢查與部署流程。

---

## 0. 參考網站實測拆解

以瀏覽器實際讀取 DOM 與 computed style 取得，數值為參考站現況。

### 0.1 首頁 Hero 預購輪播（Splide `type: fade`）

| 項目 | 參考站實作 |
| --- | --- |
| 結構 | `li.splide__slide` → `.split-slideshow__slider--left/right`（左右交錯）→ `.slider__image-wrapper`（圖）＋ `.slider__content`（`h2` 標題、`p` 一句導購文、`a.btn` 「預購請點」） |
| 切換 | 整張 slide `opacity 0.4s cubic-bezier(.25,1,.5,1)` 交叉淡化；自動播放 `interval 2000ms`；可拖曳；左右箭頭 |
| 圖片進場 | 非作用中：`opacity:0; translateX(-80px)` → 作用中：`opacity:1; translateX(0)`，`transition .6s ease-out` |
| 文字面板進場 | 非作用中：`opacity:.2; translateX(30px)` → `opacity:1; translateX(0)`，`.6s ease-out` |
| **文字分層淡入上移** | `h2`／`p`／`.btn` 非作用中皆為 `opacity:0; translateY(60px)`；作用中歸零，`transition: .6s ease-out`，**延遲分別 0.3s／0.4s／0.5s** |
| 版面 | 桌機左右分欄（圖／文交錯）；手機上圖下文堆疊，文字區純色底（每張可自訂底色與按鈕色） |
| 圖片 | `srcset` 550/710/1500w WebP，另有 mobile 專用圖 |

### 0.2 商品頁

| 區塊 | 參考站實作 |
| --- | --- |
| 網址 | 獨立頁 `/products/<slug>`，可分享、可被收錄 |
| 多圖 | `ul.slider` 為 `display:flex; overflow-x:auto; scroll-snap-type:x mandatory`，每張 `scroll-snap-align:start`，手機露出下一張邊緣（peek）；計數器 `1 / 6`；上一張／下一張按鈕；點圖開大圖 modal |
| 購買資訊 | 標題、價格、預購注意事項、規格選擇（全款／訂金）、數量、加入購物車、收藏、分享 |
| 詳細介紹 | 長文字：`團隊：`、`作品：`、`尺寸：`、`預計出貨日：` 等「鍵：值」行＋預購須知＋售後條款 |
| 推薦商品 | 「您可能也喜歡」4 張商品卡，`grid--2-col`（手機）／`grid--4-col-desktop` |

### 0.3 參考站值得「不要照抄」的地方

- 輪播 2 秒過快，文字尚未讀完就切換；本專案改 5.5 秒，並在 hover／focus／分頁隱藏時暫停。
- 所有 slide 圖片都 `loading="lazy"`，含首張 → 首屏 LCP 變慢；本專案首張 eager＋`fetchpriority="high"`。
- 商品詳細介紹直接塞在購買欄內，長文把「加入購物車」推遠；本專案拆成購買欄＋下方分節介紹。

---

## 1. 專案現況與關鍵限制（已核對程式碼）

| 項目 | 現況 | 對本次功能的影響 |
| --- | --- | --- |
| 首頁 Hero | `public/index.html` 左側品牌文案＋右側單一 `hero-product-spotlight`；`renderHeroSpotlight()`（`public/app.js:288`）只取一件現貨 | 需改為多張預購 slide |
| 開機畫面 | `waitForHeroImageDecode()` 等待 `#hero-product-visual img` 解碼才關閉 boot screen | 改 Hero 時必須同步改這個 selector，否則開機畫面會等到 timeout |
| 商品詳情 | `<dialog id="product-detail-dialog">`＋`renderProductDetail()`（`app.js:714`），單圖、`description` 純文字 | 升級為獨立商品頁視圖 |
| 商品圖片 | 每商品僅 1 張：`products.image_path`，私有 bucket `product-images`，由 Worker `/api/product-images/:productId` 代理＋edge cache（`src/index.ts:728–860`） | 需新增多圖資料表、路由與後台管理 |
| 型錄 API | `/api/catalog` 讀 `storefront_variants` view，已含 `product_id`、`product_name`、`description` | 多圖與長介紹不宜塞進首頁型錄，應另開單品 API |
| SPA fallback | `wrangler.jsonc` 已設 `not_found_handling: "single-page-application"`＋`run_worker_first`，Worker 最後 `env.ASSETS.fetch` | `/products/:id` 可直接回 `index.html`，**不需新增 Worker 頁面路由** |
| 相對資源路徑 | `index.html` 用 `styles.css`、`app.js`、`Logo.webp` 相對路徑；`app.js` 用 `./liff-auth.js` | 在 `/products/xxx` 下會解析成 `/products/styles.css` → **必須先改為根目錄絕對路徑** |
| CSP | `style-src 'self' 'sha256-…'`，無 `unsafe-inline`；`img-src 'self' data:` | 不能在 innerHTML 寫 `style="…"`；動態值用 class 或 `el.style.setProperty()`；圖片一律走同源 Worker；修改 `<style id="auth-boot-critical">` 會改變 hash，需同步更新 CSP |
| Auth 回跳 | OAuth `redirect_to` 使用 `location.pathname`；`AUTH_RETURN_STATE_KEY` 比對 `returnPath` | 在商品頁登入會回到 `/products/:id`；需確認 Supabase Redirect URLs 允許子路徑，LIFF endpoint 子路徑行為需實測 |
| Hash | `#products`、`#policy` 為錨點；OAuth／LIFF 會在 hash 帶 token | **不可用 hash 路由**，改用 History API |
| 檔案大小 | `app.js` 3797 行、`styles.css` 1444 行、`src/index.ts` 1942 行，已超過 500 行規則 | 新功能一律以新 ES module／新 CSS／新 TS 模組實作，`app.js` 只加接線程式 |
| 已確認產品約束 | 商品格手機 2 欄、平板／桌機 4 欄；手機輸入 ≥16px；彈窗關閉鈕捲動可見；預購訂金 50%；預購 2 小時、現貨匯款 24 小時付款期限 | 推薦卡沿用 2／4 欄；大圖 lightbox 關閉鈕 sticky；商品頁顯示正確付款期限文案 |

---

## 2. 方案比較與建議

### 2.1 Hero 放置方式

| 方案 | 說明 | 優點 | 缺點 |
| --- | --- | --- | --- |
| A. 全寬輪播取代 Hero | 首屏整塊變成預購輪播，品牌文案移到輪播下方 | 最接近參考站；預購曝光最大 | 失去「今天，開哪一盒？」品牌記憶點；boot／LCP 依賴大圖 |
| **B. 保留左側品牌文案，右側 spotlight 換成輪播（建議）** | `hero-selection` 內改為輪播卡，文字分層動畫套在卡內 | 保留現有視覺系統與 CTA；改動面小；手機仍上文下圖 | 輪播面積較小，桌機需放大右欄比例 |
| C. Hero 下方新增獨立「預購搶先」輪播區 | Hero 不動，trust-rail 後插入 | 零風險 | 首屏看不到預購，未達目標 |

建議 **B**，保留 A 作為後續 A/B 選項（CSS 以 `.hero--carousel-full` modifier 預留）。

### 2.2 輪播／滑動實作

| 方案 | 優點 | 缺點 |
| --- | --- | --- |
| **原生：CSS transition＋`scroll-snap`＋少量 JS（建議）** | 無新依賴、符合 CSP `script-src 'self'`、體積 < 6KB | 需自己處理 a11y 與 autoplay 暫停 |
| Splide／Swiper（vendor 進 `public/vendor/`） | 功能完整、手勢成熟 | 專案無 bundler，需手動管版本；多 30–40KB；CDN 違反 CSP |

### 2.3 商品頁形式

| 方案 | 優點 | 缺點 |
| --- | --- | --- |
| **History API 路由 `/products/:productId`，同一 SPA 內切換視圖（建議）** | 可分享、可返回、LINE 分享有獨立網址；Worker 已有 SPA fallback | 需處理 popstate、捲動位置、資源絕對路徑與 auth 回跳 |
| 擴充現有 dialog | 改動最小 | 無法分享網址；長介紹＋推薦在 modal 內捲動體驗差 |

「查看規格」改為導向商品頁；原 dialog 暫留為 fallback，穩定後移除。

### 2.4 詳細介紹資料格式

| 方案 | 優點 | 缺點 |
| --- | --- | --- |
| 沿用 `description` 單欄 | 無 migration | 卡片摘要與長介紹混用 |
| **新增 `products.details text`＋安全行格式化器（建議）** | 店主照參考站方式貼「團隊：…」即可；行首 `・`／`-` 轉清單；空行分段；「鍵：值」轉規格表；全程 `textContent`／escape，無 XSS | 格式能力有限（無粗體／連結） |
| Markdown／富文字 | 表現力高 | 需 sanitizer，CSP 與 XSS 風險上升 |

`description` 保留為一句話摘要（Hero 導購文、卡片），`details` 為商品頁長文。

---

## 3. 資料層設計（Supabase）

新增增量 migration（檔名依當日序號，例：`202609240001_product_gallery_and_showcase.sql`），**不重跑舊 migration**。

```sql
-- 多圖
create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null unique,
  sort_order integer not null default 0,
  alt_text text check (char_length(alt_text) <= 120),
  width integer check (width > 0),
  height integer check (height > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_images_product_sort_idx on public.product_images (product_id, sort_order);
alter table public.product_images enable row level security;
-- 不開放 anon/authenticated 直接讀寫；Worker 以 service role 代理並先驗證 is_published / requireAdmin
revoke all on public.product_images from anon, authenticated;

-- 商品頁長介紹與 Hero 設定
alter table public.products
  add column if not exists details text check (char_length(details) <= 8000),
  add column if not exists hero_rank integer check (hero_rank between 1 and 12),
  add column if not exists hero_tagline text check (char_length(hero_tagline) <= 80);
```

- 回填：既有 `products.image_path` 以 `sort_order = 0` 寫入 `product_images`；`products.image_path` 在過渡期保留為「主圖」並與 sort 0 同步（由 RPC 維護），避免舊前台、後台縮圖與 `storefront_variants.has_image` 中斷。
- 每商品上限 10 張（RPC 內檢查）。
- 管理 RPC（security definer、記錄 audit log，沿用 `admin_update_product_image` 的 actor 寫法）：`admin_add_product_image`、`admin_reorder_product_images`、`admin_delete_product_image`、`admin_update_product_showcase(details, hero_rank, hero_tagline)`。
- `storefront_variants` view 追加 `hero_rank`、`hero_tagline`（首頁輪播只需這兩欄；`details` 與圖片列表不進型錄）。
- 需驗證的權限案例：anon／一般會員直接 REST 讀寫 `product_images` 應被拒；未上架商品的圖片 URL 回 404；非管理員呼叫管理 RPC 被拒。

---

## 4. Worker API 設計（新模組 `src/product-showcase.ts`）

| Method／Path | 權限 | 說明 |
| --- | --- | --- |
| `GET /api/products/:productId` | 公開 | 回傳商品（僅已上架）、所有已上架規格、`details`、`images:[{id,url,width,height,alt}]`、推薦用欄位；`Cache-Control: public, max-age=60` |
| `GET /api/product-images/:productId/:imageId` | 公開 | 驗證商品已上架且圖片屬於該商品後代理 Storage；edge cache key 以 imageId 為準；`immutable` |
| `GET /api/product-images/:productId` | 公開 | **保留相容**：回傳主圖（sort 0） |
| `POST /api/admin/products/:productId/images` | `requireAdmin` | 多檔上傳（沿用 MIME＋簽章＋5MB 檢查），路徑 `${productId}/${imageId}.${ext}` |
| `PATCH /api/admin/products/:productId/images/order` | `requireAdmin` | 傳入 imageId 陣列，RPC 驗證集合完全一致 |
| `DELETE /api/admin/products/:productId/images/:imageId` | `requireAdmin` | RPC 成功後刪 Storage 物件並 purge edge cache |

- 推薦邏輯在前端用已載入的 `/api/catalog` 計算，不另開 API：同分類 → 同類型（現貨／預購）→ `display_order`；排除本商品與無可售規格；取 4 件。
- 路由註冊在 `src/index.ts` 只加 dispatch 行，實作放新模組，控制 `index.ts` 不再膨脹。
- 既有速率限制（Cloudflare API rate limits）需涵蓋新的公開 GET 路由。

---

## 5. 前端設計

### 5.1 新增檔案（皆 < 500 行）

| 檔案 | 職責 |
| --- | --- |
| `public/hero-carousel.js` | `createHeroCarousel(root, slides, { interval })`：切換、autoplay、暫停、箭頭／圓點、指標拖曳、鍵盤、reduced-motion |
| `public/product-router.js` | `/products/:id` 解析、`navigateToProduct()`、`popstate`、首頁捲動位置保存與還原、`document.title` |
| `public/product-page.js` | 商品頁視圖渲染：購買欄（沿用規格／數量／加入購物車邏輯）、詳細介紹、推薦區 |
| `public/product-gallery.js` | scroll-snap 多圖、計數器、縮圖列、prev/next、lightbox |
| `public/product-details-format.js` | `details` 純文字 → 安全 DOM（規格表／清單／段落） |
| `public/product-card.js` | 從 `renderProducts()` 抽出 `productCardMarkup(product)`，首頁與推薦共用 |
| `public/product-showcase.css` | 以上元件樣式，於 `styles.css` 之後載入 |
| `public/admin-product-images.js` | 後台多圖上傳（沿用現有 WebP 轉檔）、排序、刪除、`details`／Hero 欄位 |

`app.js` 只做：import、`renderHeroSpotlight()` 改呼叫 carousel、`[data-detail]` 改 `navigateToProduct()`、boot 圖片 selector 更新、後台接線。

### 5.2 Hero 輪播動畫規格（依參考站數值，微調節奏）

```css
.hero-slide { position:absolute; inset:0; opacity:0; visibility:hidden;
  transition: opacity .45s cubic-bezier(.25,1,.5,1), visibility 0s linear .45s; }
.hero-slide.is-active { opacity:1; visibility:visible; transition-delay:0s; }

.hero-slide__media { opacity:0; transform:translateX(-80px); transition:opacity .6s ease-out, transform .6s ease-out; }
.hero-slide__panel { opacity:.2; transform:translateX(30px); transition:opacity .6s ease-out, transform .6s ease-out; }
.hero-slide.is-active :is(.hero-slide__media, .hero-slide__panel) { opacity:1; transform:none; }

/* 文字分層淡入上移：類別標籤 → 標題 → 導購文 → 價格／CTA */
.hero-slide [data-stagger] { opacity:0; transform:translateY(60px);
  transition:opacity .6s ease-out, transform .6s cubic-bezier(.22,1,.36,1);
  transition-delay: calc(.2s + var(--stagger-i, 0) * .1s); }
.hero-slide.is-active [data-stagger] { opacity:1; transform:none; }

@media (max-width:760px){ .hero-slide__media{ transform:translateY(-24px);} [data-stagger]{ transform:translateY(32px);} }
@media (prefers-reduced-motion:reduce){ .hero-slide, .hero-slide *{ transition:none !important; transform:none !important; } }
```

- `--stagger-i` 由 JS 以 `el.style.setProperty()` 設定（CSP 允許 CSSOM，不可寫 `style=""` 屬性）。
- 離場的 slide 立即移除 `is-active`，使子元素瞬間回到初始位置但整張 slide 在淡出中，下一次進場才能重播動畫。
- 桌機奇偶 slide 以 `.hero-slide--reverse` 左右交錯；手機上圖下文。
- 資料來源：`hero_rank` 非空且有圖、類型為預購、有可售規格的商品，依 `hero_rank`；若 0 筆則 fallback「最新 5 件有圖預購」；再 0 筆則回到現有單一 spotlight（保留 `renderHeroSpotlight` 空狀態）。
- 行為：interval 5500ms；`mouseenter`／`focusin`／`visibilitychange` 暫停；單張時不顯示控制與不 autoplay；左右滑動閾值 40px；`←`／`→` 鍵切換。
- A11y：`role="region" aria-roledescription="carousel" aria-label="預購搶先看"`；每張 `role="group" aria-roledescription="slide" aria-label="2 / 5"`；非作用中 slide 設 `inert`；提供暫停／播放按鈕（WCAG 2.2.2）。
- 效能：首張 `loading="eager" fetchpriority="high" decoding="async"`，其餘 lazy；`width/height` 固定比例避免 CLS；`waitForHeroImageDecode()` 改指向 `.hero-slide.is-active img`。

### 5.3 商品頁版面

```
桌機 ≥1021px                         手機 ≤760px
┌────────────────────┬───────────┐  ┌───────────────┐
│ Gallery（sticky）   │ 購買欄     │  │ Gallery 滑動＋1/6 │
│ 主圖 scroll-snap    │ 分類·類型  │  ├───────────────┤
│ ‹ 1 / 6 ›          │ 標題 價格  │  │ 標題 價格 規格  │
│ 縮圖列              │ 規格 數量  │  │ 數量 加入購物車 │
│                    │ 加入購物車 │  │（底部 sticky CTA）│
│                    │ 預購／付款提示│ ├───────────────┤
├────────────────────┴───────────┤  │ 規格表          │
│ 商品介紹：規格表 → 內文 → 購物須知摘要 │  │ 內文／須知       │
├────────────────────────────────┤  ├───────────────┤
│ 您可能也喜歡（4 欄商品卡）         │  │ 推薦（2 欄）     │
└────────────────────────────────┘  └───────────────┘
```

- Gallery：`scroll-snap-type:x mandatory`，手機 slide 寬 88% 露出下一張；`IntersectionObserver` 更新計數器與縮圖 active；prev/next 使用 `scrollTo({behavior})`（reduced-motion 時 `auto`）。
- Lightbox：新 `<dialog id="product-lightbox">`，全螢幕同一套 scroll-snap；關閉鈕 `position:sticky` 永遠可見（產品約束）；Esc／返回鍵關閉；不做雙指縮放以外的自訂手勢，保留瀏覽器原生 pinch-zoom。
- 購買欄：沿用 `detailVariants()`、限購與庫存計算；預購顯示「訂金 50%，訂單成立後 2 小時內完成付訂」、現貨匯款顯示「24 小時內完成」，文案集中為常數與結帳頁共用，避免兩處不一致。
- 手機底部 sticky CTA：購買欄離開視窗後出現，避免與既有 `selection-tray` 重疊（商品頁時隱藏 tray 或合併）。
- 詳細介紹格式器規則：`/^(.{1,12})[：:]\s*(.+)$/` → 規格表列；`・`、`-`、`•` 開頭 → `<ul>`；空行分段；其餘段落用 `textContent`。
- 進場動效：區塊以 `IntersectionObserver` 加 `.is-revealed`，與 Hero 同一套 `translateY + opacity`，距離縮小為 24px，只觸發一次。
- SEO／分享：路由切換時更新 `document.title` 與 `meta[name=description]`；（選配）Worker 對 `/products/:id` 注入 OG tags 供 LINE 預覽，列為 Stage 6。

---

## 6. 分階段實作

每階段可獨立驗收、可單獨提交；部署依 AGENTS.md 由單一 deployment owner 在最後統一進行。

### Stage 1：基礎準備（無視覺變化）
**Goal**：路徑絕對化、抽出共用商品卡、建立新 CSS／JS 入口。
**Success Criteria**：`index.html` 資源改 `/styles.css`、`/app.js`、`/Logo.webp` 等；直接開啟 `/products/任意` 仍正確載入首頁；首頁外觀零差異。（`app.js` 內的 `./liff-auth.js` 是相對於模組本身解析，`/app.js` 絕對化後已正確，不需改。）
**Tests**：`node --check`；桌機／平板／手機截圖比對；`/`、`/products/x` 皆無 404 資源；LINE 登入回跳正常。
**Status**：Complete（2026-09-23）
**實際結果**：
- 新增 `public/product-format.js`（商品格式化純函式，自 `app.js` 移出）、`public/product-card.js`（`productCardMarkup()`）、`public/product-showcase.css`（空入口）。`app.js` 3797 → 3762 行。
- 新舊商品卡 HTML 以 4 組邊界資料（特價＋特殊字元、預購、無圖＋0 元、只有 product_name）逐字比對完全相同。
- `wrangler dev`（port 8082）實測：`/` 與 `/products/<uuid>` 所有資源、`/api/config`、`/api/catalog`、商品圖皆 200；開機畫面正常結束；「查看規格」「加入購物車」正常；`node --check`、`npm run typecheck`、`git diff --check` 通過。
- **未驗證**：LINE 登入實際回跳（需真實帳號與 Supabase Redirect URLs 設定），列入 Stage 5 驗收；桌機截圖因預覽窗格寬度受限未取得，本階段未改動任何既有 CSS。

### Stage 2：資料層與 Worker API
**Goal**：migration、管理 RPC、`src/product-showcase.ts` 新路由、主圖回填。
**Success Criteria**：`GET /api/products/:id` 回傳 images／details；未上架商品 404；舊 `/api/product-images/:productId` 仍可用；anon 直接 REST 讀 `product_images` 被拒。
**Tests**：`npm run typecheck`；允許／拒絕案例（anon、會員、管理員、偽造 imageId、跨商品 imageId、超過 10 張、錯誤簽章檔）；`wrangler deploy --dry-run --minify`。
**Status**：Complete（2026-09-23 部署）
**部署紀錄**：正式 DB（專案 `labubu`）套用 migration `product_gallery_showcase`，遠端版本號 `20260923145715`（本機檔名 `202609240001_product_gallery_showcase.sql`，內容相同、僅去掉 begin/commit）。Worker Version ID `d5eb0a43-9d4a-4450-a1ce-0232eb259b64`，100% 流量；前一版 `3cb5d417-1c4f-4268-a92e-fe57e348cf22` 可作回滾。
**正式環境驗證**：DB 唯讀核對 4/4 主圖回填、0 筆不一致、anon／authenticated 對新表與 RPC 皆無權限、`retry` 保留；Node fetch smoke 20 項全過（health、config、型錄含 hero 欄位、商品頁 API、多圖與舊主圖讀取、不存在商品／圖片 404、4 個管理路由未登入 401、首頁與 `/products/:id` 深層連結、新前端資源與 marker）；正式首頁瀏覽器開啟無錯誤、無失敗請求。
**未驗證**：管理員實際上傳／排序／刪除（需管理員 LINE 登入，第 3 階段後台 UI 完成時一併實測）。
**實際結果**：
- 新增 `supabase/migrations/202609240001_product_gallery_showcase.sql`、`src/product-showcase.ts`（商品頁 API、多圖代理、後台多圖／展示 RPC 路由）、`src/product-image-storage.ts`（自 `index.ts` 移出的圖片儲存／快取共用工具）。`index.ts` 1942 → 1905 行。
- PGlite（WASM Postgres）以最小 schema 替身實測 migration：41 項全過，含可重複執行、主圖回填、非管理員／anon／authenticated 拒絕、路徑偽造、10 張上限、排序集合驗證、刪除後重排與主圖同步、舊版單張上傳相容、展示欄位長度／範圍、既有 `retry` 稽核動作保留。
- 正式 DB 唯讀核對：遠端 migration 已套用至 `liff_session_vault`；`audit_logs_action_check` 已含 `retry`（已修正 migration 避免誤刪）；`product_images` 尚不存在；4 件商品有主圖將被回填。
- `npm run typecheck`、`git diff --check`、`wrangler deploy --dry-run --minify` 通過；`wrangler dev` 路由實測：4 個管理路由未登入皆 401、非 UUID 路徑 404。
- **部署順序限制**：`/api/catalog` 已改讀 `hero_rank,hero_tagline`，**必須先套用 migration 再部署 Worker**，否則首頁型錄 503。
- **既有缺口（未修）**：`/api/admin/audit-logs` 的 action 篩選白名單沒有 `retry`，無法篩選通知重試紀錄；不在本案範圍。

### Stage 3：後台多圖與展示欄位
**Goal**：後台上傳多張、拖曳或上下鍵排序、刪除、設定 `details`／`hero_rank`／`hero_tagline`。
**Success Criteria**：排序後前台順序一致；刪除後 edge cache 失效；稽核紀錄可查。
**Tests**：上傳 JPG／PNG／WebP、>5MB、偽造副檔名；手機後台操作；audit log 內容。
**Status**：Complete（2026-09-24 管理員實機驗收）
**實機驗收**：以店主管理員登入於正式站對 UX20 實測：批量上傳 2 張（轉 WebP 800×800、主圖不變）、排序（後台與公開 API 順序一致）、詳細介紹儲存後商品頁正確顯示規格表／小標題／清單、刪除（資料列與 Storage 物件皆移除、已刪圖片 404）、全部復原至測試前狀態（1 張圖、介紹與輪播欄位為空）；稽核紀錄完整（2 上傳→排序→介紹→2 刪除→清除介紹）。
**驗收時發現並修正（範圍外既有問題）**：`/api/admin/audit-logs` 回傳 `logs` 與扁平分頁，前端讀 `auditLogs` 與 `pagination.audit`，稽核頁一律空白。改為與通知紀錄 API 相同格式；經店主同意部署 Version ID `0eabe06a-f9cf-4671-83bf-1c59e13c0f6b`，實測全部 9 筆、「刪除」2 筆、「上傳」2 筆皆正確顯示。
**部署紀錄**：Worker Version ID `e9ccd853-1f9e-4e03-ab00-7a79965e4338`，100% 流量；前一版 `d5eb0a43-9d4a-4450-a1ce-0232eb259b64` 可作回滾。部署前逐行比對線上資源：差異僅限本階段的 `app.js`、`index.html`、`product-showcase.css`、`admin-product-gallery.js` 與 Worker 後台商品查詢欄位；Wrangler 實際上傳 4 個資源檔。無資料庫變更。
**正式環境驗證**：Node fetch smoke 11 項全過（health、型錄、商品頁 API、後台多圖／展示／dashboard 未登入 401、新模組以 JS 型別提供、app.js／CSS／index.html marker、深層連結）；正式首頁瀏覽器開啟無錯誤、無失敗請求。
**實際結果**：
- 新增 `public/admin-product-gallery.js`：批量上傳（前端多選、逐張轉 WebP 後依序送出，單張失敗不中斷整批，超過 10 張自動截斷並提示）、←／→ 排序（第 1 張即主圖）、刪除確認、商品詳細介紹（字數計數）、首頁輪播排序與導購文。後端沿用第 2 階段單張 API，未新增路由。
- `app.js` 只加接線（3762 → 3770 行）；`prepareProductImage()` 另回傳寬高供前台排版避免版面跳動；後台說明文字與「更換主圖（第 1 張）」標籤更新；稽核篩選新增「刪除」。
- Worker 兩處後台商品查詢加入 `details,hero_rank,hero_tagline,product_images(...)`；以唯讀查詢確認正式 schema 可解析（4 件商品、4 張圖）。
- 暫時測試頁（已刪除）以 mock API 實測：批量 4 張含 1 張失敗、超額截斷、排序改主圖、刪除主圖遞補、展示設定送出與字數計數；手機寬度輸入 16px、無水平捲動。
- **限制**：未上架商品的既有照片走公開圖片路由會 404，後台顯示「上架後可預覽」；本次工作階段上傳的照片以 data URL 直接預覽。
- **未驗證**：真實管理員登入下的上傳／排序／刪除（需部署後由管理員操作）。

### Stage 4：Hero 預購輪播
**Goal**：`hero-carousel.js`＋樣式，取代右側 spotlight。
**Success Criteria**：分層淡入上移節奏符合 5.2；0／1／多張三種資料狀態正確；reduced-motion 無動畫；boot screen 正常結束；LCP 圖為首張 slide。
**Tests**：375／768／1280 寬截圖；鍵盤操作；分頁切換暫停；Lighthouse LCP／CLS 與改版前比較。
**Status**：Complete（2026-09-23 部署）
**部署紀錄**：Worker Version ID `f7e3bf64-bfed-411b-ab16-86c4548170a4`，100% 流量；前一版 `e9ccd853-1f9e-4e03-ab00-7a79965e4338` 可作回滾。部署前確認自上次部署後僅 5 個本階段檔案變動（無 `src/`），Wrangler 實際上傳 5 個資源檔。
**正式環境驗證**：smoke 9 項全過（health、型錄、4 個新／改檔 marker、JS MIME、深層連結）；正式首頁輪播 2 張、首張為 BX35、無錯誤、無失敗請求；CLS 0；LCP 元素為首張輪播圖，重新整理實測 LCP 1.16s（FCP 0.22s、型錄 0.48s）。首次冷啟動測得 11.1s 為預覽窗格取 HTML 即耗 4.1s 且窗格未即時繪製所致，非本次改動造成。
**決策變更（2026-09-23）**：店主將現貨商品（UX11）設入輪播，選品規則改為「有後台排序＋有照片＋有可售量即上輪播，不限預購／現貨」；全部未設定時才自動取最新 5 件有圖預購商品；再無則回到原單一 spotlight。後台提示文字同步修改。
**實際結果**：
- 新增 `public/hero-slides.js`（選品與標記）、`public/hero-carousel.js`（行為）；`app.js` 只改 `renderHeroSpotlight()` 分流與開機畫面等待的圖片 selector（改為 `#hero-product-spotlight img`）。
- 動畫依參考站實測：交叉淡化 .45s、圖片 80px 滑入（奇偶張左右交錯）、文字 60px 分層淡入上移、每層間隔 .1s；手機位移減半；開機畫面結束後才播放第一張進場。
- 自動輪播 5.5 秒；滑鼠停留、鍵盤焦點、分頁隱藏、按下暫停時停止；系統「減少動態」時預設不自動播放且關閉位移動畫；←／→ 鍵、左右滑動（垂直捲動不攔截）、圓點、暫停／播放鈕；非作用中 slide 設 `inert`。
- 深色卡片上的特價紅字對比 2.78:1 未達 WCAG，輪播內改淺色（約 8:1）。
- 驗證：Node 單元測試 9 項（排序、無庫存／無圖排除、預購 fallback、多規格「起」、上限 12、XSS 跳脫、單張無控制列、無 inline style）；本機 wrangler dev 以正式型錄實測切換、分層延遲、自動播放、暫停、鍵盤、滑動、CTA 開啟對應商品、兩張高度一致（無版面跳動）、首張 `fetchpriority=high`、無 CSP 違規、手機寬度無水平捲動。
- LCP：舊版已被取代無法同條件對照；新版正式站 1.16s 在 Google「良好」標準（< 2.5s）內。

### Stage 5：商品頁（多圖、介紹、推薦）
**Goal**：`product-router.js`、`product-page.js`、`product-gallery.js`、`product-details-format.js`、lightbox。
**Success Criteria**：卡片點擊進入 `/products/:id`，返回鍵回到原捲動位置；多圖可滑動、計數正確；推薦 4 件不含本商品；加入購物車與既有購物車／會員同步一致；在商品頁 LINE 登入後回到同一商品頁。
**Tests**：0／1／10 張圖；長文與空 details；下架商品網址（顯示「商品已下架」＋回首頁）；規格切換價格／庫存；手機 2 欄、桌機 4 欄推薦；lightbox 關閉鈕捲動可見；LIFF 內開啟商品頁。
**Status**：Complete（2026-09-24；店主已以手機從 LINE 內點商品連結實測，可正常開啟並登入）
**登入回跳實測**：店主於商品頁完成 LINE 登入後回到同一商品頁（`/products/ff1d…`），已登入、網址 token 已清除。首次嘗試回到首頁的原因經查為該次登入由首頁發起（16:07）；商品頁發起的 16:04 那次未完成。Supabase 已接受 `/products/...` 作為回跳網址（`auth.flow_state.referrer` 佐證）。
**部署紀錄**：Worker Version ID `217f31f2-97c2-4f0a-b732-3c14a3ebf508`，100% 流量；前一版 `f7e3bf64-bfed-411b-ab16-86c4548170a4` 可作回滾。僅 7 個本階段前端檔案變動、無 `src/`，Wrangler 實際上傳 7 個資源檔。
**實際結果**：
- 新增 `product-router.js`（History API）、`product-page.js`（視圖、購買欄、推薦、手機固定購買列、區塊進場）、`product-gallery.js`（scroll-snap 多圖＋全螢幕大圖）、`product-details-format.js`（安全格式化）、`product-page.css`；`index.html` 新增 `#product-page` 與 `#product-lightbox`。
- `app.js`：加入購物車抽成 `addVariantQuantityToCart()`（對話框與商品頁共用，檢查邏輯不變）；`openProductDetail()` 有 `product_id` 時改進商品頁；首次渲染後同步路由。
- 購物須知摘要依店主決定按類型自動顯示（預購：訂金 50%／2 小時付訂／海運集運；現貨：24 小時付款／取貨方式），附「完整購物須知」連結回首頁 #policy。
- 修正過程發現並修正：全站 `scroll-behavior:smooth` 會讓換頁捲動變成動畫（改 instant）；手機固定購買列在快速滑過時不觸發（IntersectionObserver 門檻，改放大底部 rootMargin）；網址與時間被誤判成規格表（regex 排除 `//` 與純數字鍵）。
- 驗證：格式化器 12 項、本機實測（卡片圖片／名稱／查看規格進入、數量加減、加入購物車、超量阻擋、上一頁還原首頁捲動位置、下一頁、頁首錨點回首頁、深層連結、預購／現貨須知、大圖開關與關閉鈕可見與捲動鎖、手機固定購買列、下架／非 UUID 商品提示與返回、桌機雙欄與 sticky 圖片、推薦 4 欄／手機 2 欄、無水平捲動）；正式站 smoke 與瀏覽器檢查無錯誤。
- **待實測**：在商品頁 LINE 登入後回到同一商品頁；LIFF 內開啟商品頁；後台多圖實際上傳／排序／刪除（需管理員登入）。

### Stage 6（選配）：分享預覽與收尾
**Goal**：Worker 對 `/products/:id` 以 HTMLRewriter 注入 OG title／image；移除舊 product-detail dialog；更新 README。
**Success Criteria**：LINE 貼網址出現商品圖與名稱；無殘留死碼。
**Tests**：LINE 分享預覽；`git diff --check`；正式部署後依 AGENTS.md smoke（含 `/products/<id>` 回 200、`/api/products/<id>` 回 JSON、`app.js`／`product-showcase.css` marker）。
**Status**：Complete（2026-09-24 部署；店主 2026-09-24 確認 LINE 分享可看到預覽圖）
**部署紀錄**：Worker Version ID `bcd0360e-430e-4e69-9cb3-01965c6964e0`，100% 流量；前一版 `0eabe06a-f9cf-4671-83bf-1c59e13c0f6b` 可作回滾。實際上傳 5 個前端資源檔。
**店主追加（同批部署）**：
- 商品卡「查看規格」改為「直接購買」：尚未在購物車才加入 1 件，再打開購物車抽屜（不直接跳結帳）；售完時兩顆按鈕停用並顯示「已售完」；商品頁改由圖片與名稱進入，名稱加淡底線提示。同時修正推薦卡按鈕仍顯示舊文字「加入選物盒」。
- 大圖關閉鈕：原被 `dialog .dialog-close` 白底與 `!important` 覆蓋成白底白字，改以 `#product-lightbox` 選擇器設為深色圓底、白色 ×、白框並固定右上角。
- LINE 預覽無圖：原因是第 6 階段當時尚未部署（抓到的是全站預設標題），非 JPG 問題。
**正式環境驗證**：smoke 11 項全過（商品頁 og:title／title／https 絕對 og:image、og:image 200 image/jpeg、CSP、首頁 Logo、舊對話框已移除、直接購買／關閉鈕 marker）；正式首頁以管理員登入狀態載入無失敗請求。
**實際結果**：
- 新增 `src/share-meta.ts`：`/`、`/products/:id` 的 HTML 由 Worker 以 HTMLRewriter 寫入 `<title>`、meta description、Open Graph（type／site_name／locale／title／description／url／image）、twitter:card 與 canonical；商品資料只讀已上架（anon view），查詢失敗或不存在時退回全站預設（Logo.png）。取 index.html 時移除條件式標頭並刪 ETag，避免各商品共用 ETag 造成 304 沿用他頁標籤。
- 移除舊商品詳情對話框：`app.js` 刪除 `renderProductDetail`／`addDetailToCart`／`detailVariants`／`activeDetailProductId` 與相關事件、登入回跳欄位（3803 → 3763 行）；`index.html` 刪除 `#product-detail-dialog`；`styles.css` 刪除 22 行專屬樣式，共用選擇器只去除舊類別。
- 本機驗證：首頁／商品頁／不存在商品的標籤內容、帶 If-None-Match 仍回 200 與正確標籤、CSP 保留、og:image 可取得、非 HTML 資源不受影響；首頁開機、輪播、「查看規格」與輪播按鈕進入商品頁皆正常、無 console 錯誤。
- **風險**：新上傳照片為 WebP，LINE 預覽對 WebP 的支援需以實際分享驗證；舊主圖為 JPG 不受影響。

---

### 上線後調整（2026-09-24，業主要求）
**Status**：Complete（2026-09-24 部署 Version ID `96826616-4578-4ace-9fc8-b41274b01d76`；前一版 `bcd0360e-430e-4e69-9cb3-01965c6964e0`）
- 店主追加：手機圖片放大至離螢幕左右各 10px（圖片框寬 `calc(100vw - 20px)`、以 `margin-left: calc(50% - 50vw + 10px)` 突破首頁內距，高度上限 `min(130vw, 68svh)`）；375／414／600px 實測左右皆 10px、無水平捲動。
- 正式站 smoke 8 項全過；正式首頁輪播 2 張、圖片離邊 10px。
- 首頁左側移除「今天，開哪一盒？」標語與說明段落；`<h1>` 改為「潮吉好頑｜玩具、公仔、戰鬥陀螺選物」並以 `.visually-hidden` 保留給搜尋引擎與螢幕報讀器。
- 輪播拿掉黑色外框與旋轉，商品圖直接放在黃底上：固定高度框內保持原比例、依最大寬度或最大高度放大（桌機 `min(48vh,500px)`、平板 `min(48vh,440px)`、手機 `min(112vw,60svh)`），圓角＋柔和陰影；圖片可點進商品頁（僅滑鼠／觸控）。隱藏原卡片後方圓環裝飾。
- 文字依業主「文字由設計師設計」重新排版於圖片下方，保留分層淡入上移：類型徽章（預購黑底／現貨白底）＋分類＋到貨日或庫存 → 商品名稱 → 導購文 → 分隔線＋價格＋黑色圓角按鈕；控制列改黃底用深色線條。
- 桌機右欄加寬（.8fr / 1.2fr）並縮小上下留白：1280×860 視窗內圖、文字、控制列全在第一屏。
- 修正：圖片框改用 flex（grid auto 列高使 `max-height:100%` 失效導致圖片溢出）。
- 驗證：單元測試 7 項；本機手機／桌機尺寸、分層延遲、下一張、滑動、點圖與按鈕進商品頁、無 console 錯誤、無水平捲動。

### 上線後調整第二輪（2026-09-24，業主要求）
**Status**：Complete（部署 Version ID `1898b0f1-7e31-4e1c-a250-af8e4ea1dfdc`；前一版 `96826616-4578-4ace-9fc8-b41274b01d76`）。正式站 smoke 全過，手機輪播距導航列 12px、圖片離邊 10px、無失敗請求。
- 首頁：移除「先看現貨／先看下單規則」；輪播直接接在導航列下方（手機間距 12px），「現貨／預購／到貨」三格移到輪播下方；全尺寸單欄置中（桌機輪播與三格皆 640px）。
- 購物須知：移除「預購／付款／退換貨」三張說明卡；標題改為「下單前，請先讀完購物須知。」，說明文字重寫並保留「不接受任何原因退換貨」條款（依店主指示不保留「送出訂單先保留庫存、確認付款後扣除」）；流程列與規則接在標題下方；規則由 `<details>` 改為直接顯示的 `<section>`，標題「代購與退換貨規則」。
- 驗證：手機 375 與桌機 1280 版面量測、HTML 標籤配對、無水平捲動。

### 上線後調整第三輪（2026-09-24）
**Status**：Complete（部署 Version ID `0efea723-9c54-4255-8304-5cee986c86aa`；前一版 `1898b0f1-7e31-4e1c-a250-af8e4ea1dfdc`）
- 「我已閱讀，回商品區」原本指向 `#products`，固定導航列會蓋住區塊標題，畫面停在「從現貨快選開始…」。改指向搜尋列 `#product-search-bar`，並以 `scroll-margin-top`（手機 128px、桌機 100px）預留導航列高度；本機實測搜尋列停在導航列下方 20px（手機）／18px（桌機）。導航列「商品」連結維持 `#products`。

### 上線後調整第四輪（2026-09-24）
**Status**：Complete（部署 Version ID `e74dd6f6-32e3-47bd-b5c7-c2e23e04d311`；前一版 `0efea723-9c54-4255-8304-5cee986c86aa`）
- 導航列「購物須知」與商品頁「完整購物須知」原指向 `#policy`，標題第一行被固定導航列蓋住；改指向 `#policy-title`，沿用 `scroll-margin-top`（手機 128px、桌機 100px）。本機實測標題停在導航列下方 20px（手機）／18px（桌機），兩個入口一致。

### 上線後調整第五輪（2026-09-24）
**Status**：Complete（部署 Version ID `a18dcc3b-fd26-43d2-8953-b02a6c01860b`；前一版 `e74dd6f6-32e3-47bd-b5c7-c2e23e04d311`）
- 所有「回商品區」入口統一落在搜尋列 `#product-search-bar`：導航列「商品」、購物須知「我已閱讀，回商品區」、我的訂單「去逛逛」、商品頁麵包屑分類與「回到商品列表」。店主回報仍看到「從現貨快選開始」是點了導航列「商品」（仍指向 `#products`）。
- 點 Logo（`#top`）改捲到頁面最頂端：`#top { scroll-margin-top: 100vh }`，避免 main 被固定導航列蓋住輪播上緣。
- 輪播文字區加圓角細框（1.5px 深色、16px 圓角、半透明白底），並以 overflow 讓分層文字在框內浮上。
- 本機 390×844 實測：各回商品入口搜尋列皆在導航列下方 20px、Logo 後 scrollY=0 且輪播圖完整露出；正式站 marker 5 項全過。

### 上線後調整第六輪（2026-09-24）
**Status**：Complete（部署 Version ID `7f55e55e-e876-42a9-a27c-fabaf3856b3a`；前一版 `a18dcc3b-fd26-43d2-8953-b02a6c01860b`）
- 店主 iPhone 回報導航列「商品」仍未停在搜尋列；Chromium 實測正確，研判為 iOS Safari 錨點跳轉處理差異或手機仍開著舊版頁面。改為不依賴 CSS `scroll-margin-top`：新增 `public/anchor-scroll.js`，攔截頁內 `a[href^="#"]` 點擊，依導航列實際高度計算落點（導航列下方 20px），並以 pushState 保留上一頁行為；商品頁回首頁、我的訂單「去逛逛」改用同一函式。`scroll-margin-top` 保留作為直接開啟帶 hash 網址時的後備。
- 本機 390×844 實測：導航列商品／購物須知、回商品區、上一頁、Logo、商品頁麵包屑與完整購物須知，全部落在導航列下方 20px（Logo 為頂端）；無 console 錯誤。

### 上線後調整第七輪（2026-09-24，業主要求）
**Status**：Complete（部署 Version ID `4ac77490-da40-42a7-82a5-5da6f040a431`；前一版 `ded8db43-575b-4b8a-abcd-d7b19af626ad`）
- 輪播下方文字區改為「介紹新品／熱款」：移除價格、庫存與到貨時間；保留品名與介紹。標籤依類型：預購＝`NEW 新品預購`、現貨＝`HOT 熱門推薦`（資料庫無新品／熱款欄位，輪播商品本身為業主挑選）。介紹文字優先用後台「輪播短語」，否則用商品說明（超過 90 字截斷、桌機最多 3 行、手機 2 行），兩者皆無時顯示預設句。保留「看介紹 →」文字按鈕（44px 觸控高度；圖片連結僅供滑鼠／觸控，鍵盤與報讀器靠此按鈕進商品頁）。
- 檔案：`public/hero-slides.js`、`public/product-showcase.css`。正式站驗證：輪播 2 張皆顯示新文字區、無價格／庫存、無 console 錯誤。
### 上線後調整第八輪（2026-09-24，業主要求）
**Status**：Complete（部署 Version ID `ef5bcb11-b742-49bc-84d4-537a312de4f7`；前一版 `4ac77490-da40-42a7-82a5-5da6f040a431`）
- 輪播文字卡的連結改為右下角圓角外框按鈕，文字改回「查看商品 →」（箭頭改為 SVG 線條圖示；報讀器讀作「查看商品：商品名稱」）。白色半透明底＋1.5px 墨黑框，hover 反白為墨黑底黃字；高 44px。按鈕與進場動畫共用 transition（進場屬性保留分層延遲、hover 顏色不延遲），並列入減少動態清單。
- 量測：295／375／1440 寬度皆位於卡片右下角（距右、下 19px＝卡片內距＋框線）。檔案：`public/hero-slides.js`、`public/product-showcase.css`。
- 設計檢測器另回報既有的輪播圓點以 `width` 做過渡（非本次修改），未處理。
### 上線後調整第九輪（2026-09-24，業主回報）
**Status**：Complete（部署 Version ID `b43ecda6-3309-40e8-9ee9-13b46121ae25`、`c97ff2bc-d61f-495c-b79d-643ac21d8a41`；前一版 `ef5bcb11-b742-49bc-84d4-537a312de4f7`）
- 後台照片「刪除」無作用：正式站稽核紀錄在業主操作期間（BX35，09-24 11:27 上傳 2 張、排序 4 次）無任何 delete，確認請求未送出；正式站以管理員登入實測，按刪除不出現確認框、無 DELETE 請求。改為畫面內兩段式確認（第一次按變紅色「確定刪除？」、3 秒內再按才刪除，逾時自動恢復），不再使用 `window.confirm`（`admin-product-gallery.js`、`product-showcase.css`）。正式站實測刪除 BX35 第 3 張（09-15 舊主圖 `primary.jpg`，業主同意）：DB 剩 2 張、主圖不變、稽核新增 delete（11:51:30）。
- 移除「編輯商品」的「更換主圖（第 1 張）」欄位（與照片區重複；舊版上傳會覆寫照片區第 1 張）。「新增商品」保留主圖欄位（建立前照片區尚不存在）。
- 快取修正（業主同意，2026-09-24 部署 `a8595f2d-c72b-4f64-8ccc-208286b2faa6`）：原本 Cache API 快取一年且快取鍵去除 `?v=`，`cache.delete` 只清處理請求的機房，其他機房仍回傳已刪除照片（實測 TPE `HIT`）。改為：
  - 快取鍵含版本；只有 `v` 與資料庫版本一致才寫入邊緣快取，`Cache-Control: public, max-age=31536000, immutable, s-maxage=86400`（邊緣最多 1 天，瀏覽器沿用一年）。
  - 舊版或亂填的 `v` 回傳目前圖片、`max-age=60`，不寫入快取，避免被灌爆快取。
  - 刪除照片、編輯商品（含下架）時清除本機房對應版本；其他機房最遲 1 天失效。新增／排序照片會更新版本，不再 purge。
  - 正式站實測：正確版本第 2 次 `HIT` 且帶 `s-maxage=86400`；錯誤版本兩次皆未進快取；不存在的圖片 404。
- 店主 2026-09-24 以 iPhone Safari 確認兩段式刪除照片正常。

### 上線後調整第十輪（2026-09-24，業主要求）
**Status**：Complete（部署 Version ID `2a8d46d4-57a0-4004-9b4e-5d909b1c7902`、`3b0bc2ba-5336-430b-8148-798c448f1548`）
- 寬螢幕輪播原本與手機相同（上圖下文）。參考站 kytoyscollection.easy.co 實測：左右分欄（圖 609px／文 406px，兩側等高 646px、文字垂直置中），且依每張設定左右換邊。
- 改為 ≥1021px：左 2/3 照片（白底完整呈現，不裁切直式盒裝圖）、右 1/3 說明（等高、垂直置中、「查看商品」右下），Hero 寬度 640 → 1180px；偶數張左右對調（沿用既有 `hero-slide--alt`，照片由右側滑入），參考站為逐張設定、本站無此欄位故採奇偶交替。平板與手機維持上圖下文。
- 新增 `public/hero-desktop.css`（`product-showcase.css` 已 492 行，避免超過 500 行），於其後載入。
- 正式站實測：1280／1440／1024 照片佔 0.667、兩欄等高、無橫向溢出，第 1、3 張照片左、第 2 張照片右；1020 與 375 維持上下排列。
- 手機照片框改依照片比例（業主要求，部署 `878be1b9-f90a-4927-bd0d-75613e687ce8`）：原本固定高 `min(130vw, 68svh)`，方形照上下各留約 66px 空白；固定高度＋`max-height:100%` 在 iOS Safari 也可能不縮放直式照（如 UX11 415×739）而切掉左右。改為 `height:auto`、圖片寬度撐滿（螢幕寬 − 20px）、直式照限制 `max-height: 68svh` 等比縮小置中。實測 375px：方形照框＝圖 355×355；UX11 由 274×487 放大為 310×552、比例正確、不超出輪播範圍；說明框一律接在圖下 20px。平板與桌機不受影響。
- 測試時首頁分隔符「／」曾一次被解讀為 Latin-1 亂碼（CSS 回應無 charset、重新載入即正常）。在含中文 `content` 字串的 `product-showcase.css`、`styles.css` 最前面加 `@charset "UTF-8";`（與原第一行同行，不增加行數），部署 `491286b3-7eeb-4ad7-ad3b-d474271b78ac`。

- 桌機放大與各尺寸比例（業主逐步要求，最終部署 `8085f10e-70cd-4892-bcaf-d75c62a24892`，皆在 `hero-desktop.css`）：
  - 寬螢幕兩側空白過多：取消 1180px 上限，左右內距改與頁首相同 `max(5vw, 24px)`，輪播左右緣對齊 Logo 與購物車。
  - 照片區撐滿第一屏：高度 `max(420px, calc(100svh - 108px))`，輪播鈕在折線下；圖片 `width/height:100%` + `object-fit: contain`，原圖較小也會放大填滿（不裁切）。
  - 說明文字隨螢幕放大：品名 `clamp(1.6rem, 2.6vw, 3.4rem)`、介紹 `clamp(1rem, 1.05vw, 1.35rem)`、按鈕與標籤同步放大（1030px 約同原尺寸、2000px 約 1.6 倍）。
  - 手機橫放（橫向、高 ≤540、寬 ≥640）改用左右分欄，照片區 `min-height` ＝螢幕高扣頁首，`contain: size` 避免原圖把欄位撐高，並還原直式手機規則的全寬負邊距。
  - 平板直向（761–1020、高 ≥541）照片區改依照片比例、寬度撐滿（原固定高 440 時方形照左右各留約 100px），直式照限 70svh。
  - 實測：1440×900 照片區 854×792、照片 750×750、輪播底 894／輪播鈕 914（折線下）；2000×1100 左右緣 100／1885 對齊頁首；768×1024 照片 640×640 無側留白；932×430 左右分欄等高 280；375×812 照片 355×355。所有尺寸無橫向溢出。
  - 已知限制：桌機照片區比例（約 2/3 寬 × 一屏高）與方形／直式商品照不同，照片以不裁切為優先，兩側會留白；若要每張都填滿寬度，需裁切或改上傳橫式輪播圖（需新增後台欄位）。

### 上線後調整第十一輪（2026-09-24，業主要求）
**Status**：Complete（部署 `ee1a593d-7dbf-4561-a9b7-e49572db4595`、`57ad7e1a-38cf-4c1e-8e23-85285eb899e9`）
- 螢幕 ≥1200px：店取地址（營業時間在地址下方）與「LINE 客服 ↗」移到頁首導航列（Logo｜選單｜店取＋LINE 客服｜會員按鈕），首頁中段店取列隱藏；<1200px 維持原位。做法：`index.html` 頁首新增 `.header-store`，兩份同時只顯示一份（display:none，報讀器不重複）。
- 所有尺寸「LINE 客服 ↗」改為 LINE 標準綠 `#06C755` 填滿、白字、圓角膠囊按鈕（hover `#05A647`，手機觸控 44px）。頁尾純文字「LINE 客服」連結未變。
- 新增 `public/store-info.css`（不再擴張 styles.css）。
- 實測：1440 與 1200（含模擬已登入多兩顆按鈕）頁首維持 82px、無溢出，營業時間在地址下方；1199 回到原店取列；375 按鈕與地址同列垂直置中。
- 注意：白字在 LINE 綠上的對比約 2.2:1，低於 WCAG AA（4.5:1），為 LINE 官方品牌配色；若要提高可讀性可改深色字。

## 7. 風險與待確認事項

（2026-09-24 更新：以下為當初規劃時列出的風險，「狀態」欄記錄目前結果。）

| # | 風險／問題 | 處理 | 狀態 |
| --- | --- | --- | --- |
| 1 | Supabase Auth Redirect URLs 若只允許根網址，商品頁登入會失敗 | Stage 1 前確認設定允許 `https://<domain>/**`；否則 `redirect_to` 固定根網址並以 `AUTH_RETURN_STATE_KEY` 帶回商品路徑 | 已解決：Supabase 接受 `/products/...` 回跳，店主實測商品頁登入後回到同一頁（Stage 5） |
| 2 | LIFF endpoint 子路徑、`liff.state` 與 History 路由互動 | Stage 5 於 LINE 內實機測試 | 已解決：店主從 LINE 內開商品連結可正常開啟並登入（Stage 5） |
| 3 | 多圖增加 Storage／流量用量 | 上傳時轉 WebP、限制長邊 1600px、每商品 ≤10 張 | 持續：邊緣快取已改為含版本的 key、`s-maxage` 1 天（第九輪） |
| 4 | 修改 `auth-boot-critical` inline style 會使 CSP hash 失效 | 盡量不動；若必須修改，同步重算 `SECURITY_HEADERS` hash | 持續注意 |
| 5 | `app.js` 過大（規劃時 3797 行） | 本案只抽出不擴張；長期拆分另立計畫 | 持續：2026-09-24 為 3752 行，拆分計畫尚未建立 |
| 6 | Hero 選品權 | 預設由後台 `hero_rank` 控制 | 已實作：全部未設定排序時自動輪播最新預購商品（`hero-slides.js`） |
| 7 | 現有 `.claude/launch.json` 是 `python -m http.server 8082`，沒有 SPA fallback 與 `/api/*` | 已新增 launch 設定 `worker-dev`（`npx wrangler dev --port 8082`）；5714 在此機器被 Windows 保留，不能使用 | 已處理 |
| 8 | 參考站素材與文案 | 只參考互動與版面模式，不複製其圖片、文案或品牌元素 | 持續遵守 |

**店主已決定（2026-09-23）**：Hero 採方案 B；推薦商品排除缺貨。
**已完成（店主 2026-09-24 確認）**：商品頁購物須知摘要內容。
**已知未處理**：輪播圓點以 `width` 做過渡（第八輪設計檢測回報，輕微動畫效能問題）。
