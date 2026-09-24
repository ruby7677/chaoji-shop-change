# Supabase Phase 13–17：商品積點資格與 Snapshot 回歸

驗證日期：2026-09-20（UTC）

本次新增商品層級 `products.points_eligible`、訂單明細 `order_items.points_eligible_snapshot`、訂單明細 INSERT snapshot trigger、完成訂單點數公式，以及後台商品新增／編輯 checkbox。所有 SQL fixture 均在同一 transaction 內執行後 `ROLLBACK`，沒有留下正式商品、訂單、庫存、點數或會員資料。

## Database

- Migration `20260919191417 product_points_eligibility`：已套用。
- ACL 修補 migration `20260919191516 product_points_admin_acl`：已套用；新版 15 參數 `admin_create_product` 僅 `service_role` 可執行。
- `products.points_eligible`：`boolean not null default true`。
- `order_items.points_eligible_snapshot`：`boolean not null default true`。
- 現有商品：4 件，`points_eligible=true` 為 3 件、false 為 1 件；false 為目前管理員已設定的商品狀態，migration 未回填或改寫既有商品。
- 現有 order_items：21 筆，snapshot true 為 21、false 為 0、NULL 為 0。
- SECURITY DEFINER `search_path` 維持空值；Security Advisor 只有既有 4 筆 authenticated function WARN 與既有 leaked-password WARN，未新增本次 warning。

## Regression result

| Case | Result |
| --- | --- |
| 全部商品可積點 | PASS：公式保留原本 eligible subtotal 行為 |
| 全部商品不可積點 | PASS：earned points = 0 |
| 可積點＋不可積點 | PASS：只計可積點商品 |
| 不可積點 quantity > 1 | PASS：全部數量排除 |
| coupon discount | PASS：從 eligible subtotal 扣除 |
| point discount | PASS：從 eligible subtotal 扣除 |
| coupon + point discount | PASS：最低為 0 |
| shipping fee | PASS：不進入 points_base |
| duplicate completed | PASS：earn ledger 只建立 1 筆 |
| refund reversal | PASS：依原本 earn ledger 沖回 |
| snapshot true → 商品改 false | PASS：完成仍依 snapshot=true 入點 |
| snapshot false → 商品改 true | PASS：完成仍依 snapshot=false 不入點 |
| 舊訂單相容 | PASS：migration 前 21 筆 order_items 全部 snapshot=true |

Transaction fixture 實際核對值：mixed eligible subtotal 2,000、coupon 200、point discount 100、shipping 150，earned points 17；全不可積點訂單 0；反向 snapshot 訂單 10；退款 reversal -17。

## Admin UI／API

- 新增商品 checkbox：未勾選送 `points_eligible=true`，勾選送 false。
- 編輯商品 checkbox：從 `products.points_eligible` 載入，儲存後送 PATCH 持久化。
- 後台商品卡會顯示「不積點」標籤。
- `ADMIN_PRODUCTS_SELECT` 輸出 `points_eligible`。
- 15 參數 `admin_create_product` 寫入 products 欄位；舊 13／14 參數版本已撤銷 service_role execute。
- 新增商品 transaction fixture：勾選 false → products.points_eligible=false，PASS；最後 rollback。
- 三種配送方式（到店、宅配、賣貨便）均以 transaction fixture 驗證 order_items snapshot trigger，PASS；最後 rollback。

## Production safety

- Production 測試資料：0（所有 fixture rollback）。
- Production 歷史訂單修改：0。
- Production 歷史 point ledger 修改：0。
- 未修改優惠券 eligibility、點數兌換、庫存 reservation、付款、配送、LINE／Telegram 通知流程。

## Deployment

- Cloudflare Version ID：`e940a805-c212-411c-a3ed-ebd361be5201`
- `/api/health`、`/api/config`、`/api/catalog`：HTTP 200（Node fetch post-deploy smoke）。
- 公開 catalog 未輸出 `points_eligible`；管理商品資源包含該欄位。
- 本次獨立 transaction regression 的 A–J 案例全部 PASS，rollback 後 `TEST-PTS-*` 訂單數為 0，正式訂單 21 筆、point ledger 53 筆均未變更。
