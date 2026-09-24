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
**Status**：Not Started

### Stage 3：後台多圖與展示欄位
**Goal**：後台上傳多張、拖曳或上下鍵排序、刪除、設定 `details`／`hero_rank`／`hero_tagline`。
**Success Criteria**：排序後前台順序一致；刪除後 edge cache 失效；稽核紀錄可查。
**Tests**：上傳 JPG／PNG／WebP、>5MB、偽造副檔名；手機後台操作；audit log 內容。
**Status**：Not Started

### Stage 4：Hero 預購輪播
**Goal**：`hero-carousel.js`＋樣式，取代右側 spotlight。
**Success Criteria**：分層淡入上移節奏符合 5.2；0／1／多張三種資料狀態正確；reduced-motion 無動畫；boot screen 正常結束；LCP 圖為首張 slide。
**Tests**：375／768／1280 寬截圖；鍵盤操作；分頁切換暫停；Lighthouse LCP／CLS 與改版前比較。
**Status**：Not Started

### Stage 5：商品頁（多圖、介紹、推薦）
**Goal**：`product-router.js`、`product-page.js`、`product-gallery.js`、`product-details-format.js`、lightbox。
**Success Criteria**：卡片點擊進入 `/products/:id`，返回鍵回到原捲動位置；多圖可滑動、計數正確；推薦 4 件不含本商品；加入購物車與既有購物車／會員同步一致；在商品頁 LINE 登入後回到同一商品頁。
**Tests**：0／1／10 張圖；長文與空 details；下架商品網址（顯示「商品已下架」＋回首頁）；規格切換價格／庫存；手機 2 欄、桌機 4 欄推薦；lightbox 關閉鈕捲動可見；LIFF 內開啟商品頁。
**Status**：Not Started

### Stage 6（選配）：分享預覽與收尾
**Goal**：Worker 對 `/products/:id` 以 HTMLRewriter 注入 OG title／image；移除舊 product-detail dialog；更新 README。
**Success Criteria**：LINE 貼網址出現商品圖與名稱；無殘留死碼。
**Tests**：LINE 分享預覽；`git diff --check`；正式部署後依 AGENTS.md smoke（含 `/products/<id>` 回 200、`/api/products/<id>` 回 JSON、`app.js`／`product-showcase.css` marker）。
**Status**：Not Started

---

## 7. 風險與待確認事項

| # | 風險／問題 | 處理 |
| --- | --- | --- |
| 1 | Supabase Auth Redirect URLs 若只允許根網址，商品頁登入會失敗 | Stage 1 前確認設定允許 `https://<domain>/**`；否則 `redirect_to` 固定根網址並以 `AUTH_RETURN_STATE_KEY` 帶回商品路徑 |
| 2 | LIFF endpoint 子路徑、`liff.state` 與 History 路由互動 | Stage 5 於 LINE 內實機測試 |
| 3 | 多圖增加 Storage／流量用量 | 上傳時轉 WebP、限制長邊 1600px、每商品 ≤10 張；edge cache immutable |
| 4 | 修改 `auth-boot-critical` inline style 會使 CSP hash 失效 | 盡量不動；若必須修改，同步重算 `SECURITY_HEADERS` hash |
| 5 | `app.js` 已 3797 行 | 本案只抽出不擴張；長期拆分另立計畫 |
| 6 | Hero 選品權 | 預設由後台 `hero_rank` 控制；需店主確認是否要自動 fallback |
| 7 | 現有 `.claude/launch.json` 是 `python -m http.server 8082`，沒有 SPA fallback 與 `/api/*` | 已新增 launch 設定 `worker-dev`（`npx wrangler dev --port 8082`）；5714 在此機器被 Windows 保留，不能使用。本機瀏覽器可能快取舊 python 伺服器的 `app.js`，驗證前需強制重新載入 |
| 8 | 參考站素材與文案 | 只參考互動與版面模式，不複製其圖片、文案或品牌元素 |

**店主已決定（2026-09-23）**：Hero 採方案 B；推薦商品排除缺貨。
**仍待決定**：商品頁購物須知摘要內容（Stage 5 前確認）。
