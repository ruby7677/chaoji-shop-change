# 規格綁定商品圖片（切換規格時主圖跟著換）

業主需求（2026-10-31）：參考蝦皮選顏色時主圖跟著換。現況：每個規格的 `image_url` 都是商品主圖（`src/catalog.ts` 由 `products.image_path` 產生），沒有「規格 ↔ 圖片」的對應；商品頁切換規格（`public/product-page.js` change 事件）只重畫購買欄，不動圖庫。

## 設計決策

- 規格只能指定**同一商品已上傳的多圖**（`product_images`），不另外上傳、不新增 R2 物件；不指定＝維持現況（商品主圖）。
- 單層規格不變（不做「顏色 × 容量」兩層選項）。
- 首頁商品卡、購物車、訂單、通知維持商品主圖，不在本次範圍。
- 前台商品頁已載入 `/api/products/:id` 的多圖（含 `id`），型錄只需多帶 `image_id`，不必在型錄算圖片網址（首頁內嵌型錄大小幾乎不變）。

## Stage 1: 資料庫
**Goal**：新 migration `202610310001_variant_image.sql`
- `product_images` 加 `unique (id, product_id)`。
- `product_variants.image_id uuid null`，複合外鍵 `(image_id, product_id) references product_images(id, product_id) on delete set null (image_id)`：保證只能選同商品的圖；刪圖自動清空、不影響規格。
- `grant select (image_id)` 給 anon／authenticated；`storefront_variants` 尾端追加 `v.image_id::text as image_id`（完整 `create or replace view`，以 202610240001 為底）。
- `admin_update_variant` 加 `p_image_id uuid default null`、`p_update_image boolean default false`（null 代表「清除」，需旗標區分「不變」）；寫出完整函式、移除舊簽名；稽核紀錄沿用既有 before/after。
**Success Criteria／Tests**（`tests/db/variant_image.test.sql`）：
- 允許：管理員指定同商品圖片、清除指定；未帶旗標時不變。
- 拒絕：指定其他商品的圖片、非管理員呼叫。
- 刪除該圖片後規格 `image_id` 變 null、規格仍在；`verify_schema.sql` 與 `backup_snapshot` 測試若列欄位一併更新。
**Status**: Complete（CI database job 通過；2026-10-31 已套用正式 DB）

## Stage 2: Worker
**Goal**：`src/catalog.ts` select 加 `image_id` 並回傳；`src/admin-catalog.ts` PATCH `/api/admin/variants/:id` 接受 `image_id`（字串 UUID 或 null，欄位存在才送 `p_update_image=true`，格式錯誤回 400）；`src/admin-dashboard.ts` 的 `ADMIN_PRODUCTS_SELECT` 規格加 `image_id`。
**Tests**：`tests/worker` 補 PATCH 帶／不帶／錯誤格式 `image_id`，型錄回傳含 `image_id`。
**Status**: Complete

## Stage 3: 後台
**Goal**：`admin-products-forms.js` 規格編輯表單新增「規格圖片」：列出該商品多圖縮圖（radio，含「不指定（用商品主圖）」）；商品沒有多圖時顯示「請先在商品多圖上傳照片」。送出接到 `admin-catalog-panel.js` 既有 PATCH；`admin-audit-diff.js` 加 `image_id: "規格圖片"`。新樣式放新 CSS 或 `admin-pages.css`（後台樣式不併入 bundle）。
**Tests**：前台 module 單元測試（表單 markup：已選、不指定、無多圖三種）；手機／桌機實際操作。
**Status**: Complete

## Stage 4: 前台商品頁
**Goal**：新增小模組（如 `public/variant-image.js`）`variantImageIndex(images, variant)` 回傳圖庫索引；`product-gallery.js` 匯出 `goTo(index)`；商品頁切換規格與以 `?v=` 進入時跳到該張（無指定或找不到時不動）。可選：規格按鈕加小縮圖（`.pp-option` 版面需手機 2 欄內不擠）。
**Tests**：`tests/frontend` 測索引對應；預覽實測切換、`?v=` 進入、無多圖商品不出錯；重跑 `build-modulepreload`、`build-css`（若改前台 CSS）。
**Status**: Complete（未做規格按鈕縮圖）

## Stage 5: 驗證與上線
- Gate：`npm run check:js`、`npm run typecheck`、`npm test`、`npm run test:db`（或 CI database job）、`git diff --check`、dry-run。
- 上線順序：**先套 migration（需業主同意）→ 再部署 Worker**（新參數有預設值，舊 Worker 仍可呼叫）。
**Status**: Complete（2026-10-31 部署 Version 77dac968）
