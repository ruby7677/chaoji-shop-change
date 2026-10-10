# 潮吉好頑｜安全營運操作清單

本清單記錄目前已完成的程式／資料庫防護，以及需要店主在 Supabase／Cloudflare 控制台完成的操作。不要把任何 secret、token、LINE user ID 或會員個資寫入本文件。

## 已完成並已部署

- Supabase `security_hardening`：LINE 好友驗證時間戳、訂單／庫存限制、限購、逾期 reservation 釋放、舊 RPC 撤銷、最小 table grants、SECURITY DEFINER 空 `search_path`。
- Supabase `public_catalog_security`：private schema 聚合可售庫存；未公開 reservation 明細不直接暴露給 anon。
- Supabase `explicit_deny_policies`：service-role-only 表建立明確 deny policies；security advisor 的 RLS 無 policy INFO 已清除。
- Worker provider allowlist：`LINE_AUTH_ENABLED=true` 時拒絕非 LINE identity 的 Supabase token。
- 無 MFA 管理模式：管理 API 要求 LINE provider identity、綁定的 `profiles.line_user_id` 與 `is_admin=true` 三者一致。
- Worker Rate Limiting API：
  - `API_ORDER_RATE_LIMITER`：每會員 10 次／60 秒。
  - `API_MEMBER_RATE_LIMITER`：每會員好友驗證／付款 30 次／60 秒；購物車、收款帳戶、我的訂單、點數查詢各自以會員 id 分開計數，同樣 30 次／60 秒（2026-09-26 補上讀取類路由）。
  - `GET /api/catalog` 不限流：Worker 記憶體快取 30 秒（每個 isolate 最多 30 秒查一次 Supabase，管理端改型錄、會員建單、管理員變更訂單狀態後立即失效；pg_cron 逾期取消由 30 秒 TTL 自然更新），瀏覽器端維持 `no-store`。
  - `API_AUTH_IP_RATE_LIMITER`：LIFF 驗證、session remember／restore、web-session start／refresh 在驗證身分前以 IP 防洪，120 次／60 秒（2026-09-26 新增；共用 IP 的 LINE 內建瀏覽器／NAT 不再互相阻擋）；驗證通過後再以 LINE sub／會員 id 走 `API_MEMBER_RATE_LIMITER` 各 30 次／60 秒。
  - `API_ADMIN_RATE_LIMITER`：每位管理員 API 60 次／60 秒（2026-09-25 由 20 次調高；以通過驗證的管理員 id 計數）。
- Worker 安全標頭：CSP、HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy。
- 最新 Worker：Version ID `16d93c0c-02e6-458d-be77-55adc2ca1a01`（2026-09-24 部署：每小時取消訂單通知只掃描 `cancellation_notified_at` 為空的訂單，migration `202609250001` 已先套用；之前 `4cee25b2` 為電腦版「管理後台」另開 `/admin` 分頁，權限仍由伺服器檢查、登入資料未改存 localStorage；之前 `f12d9aeb` 為登入過期處理、`d3241da1` 為畫面內確認視窗、`b62ef7b4` 為商品與規格頁改版與 iOS Safari 修正，其間另有首頁輪播版面調整；歷次版本見 `ADMIN_REDESIGN_PLAN.md`、`PRODUCT_SHOWCASE_PLAN.md`）。
- 商品積點 eligibility migration：`product_points_eligibility` 與 `product_points_admin_acl`；新版管理商品 RPC 僅保留 service_role execute，`search_path` 維持空值。

## 已套用 migration（2026-09-22～09-24）

2026-09-24 以 Supabase migration history 核對：以下 migration 皆已套用至正式 DB。同日已將正式 DB 的紀錄對齊檔名版本（見下方「Migration 紀錄對齊」），之後以 `npm run db:history-sql` 的唯讀 SQL 核對：

- `202609220001_member_point_balance_rpc.sql`：完整 point ledger 餘額 RPC，前台近期 100 筆只作歷程。
- `202609220002_notification_delivery_state_machine.sql`：LINE／Telegram 原子 claim、lease、claim token fencing 與 transient retry；外部 API 仍只能保證 at-least-once。
- `202609220003_inventory_cancellation_returns.sql`：取消／退款庫存狀態限制、原 sale 反轉冪等、賣貨便已出貨保守退款，以及退貨可再售／報廢驗收紀錄。
- `202609220004_audit_logs_admin_search.sql`、`202609220005_audit_existing_admin_rpcs.sql`：service-role-only、不可更新／刪除的 `audit_logs`、固定名稱管理 RPC 與資料庫端訂單／會員搜尋。既有訂單 history、inventory movements、point ledger、return confirmations 仍各自保存原始交易歷程，不由通用 audit 重複取代。
- `202609220006_admin_catalog_coupon_inventory_search.sql`：商品／優惠券／庫存異動固定 RPC 搜尋分頁，以及不受清單分頁影響的完整管理 options payload。
- `202609220007_notification_claim_found_fix.sql`：修正動態 notification claim 的 `ROW_COUNT` 判定；不改既有簽名、claim token fencing 或 service-role 權限。
- `202609230001_notification_operations.sql`：通知紀錄 service-role-only list、failed-only requeue 與 retry audit；後台重排不會直接呼叫外部通知 API。
- `202609230002_notification_display_context.sql`：通知列表補充遮罩收件人 context 與已知訂單編號；非訂單 event 不猜測關聯，仍不回傳 recipient_id、payload 或 token。
- 一般瀏覽器登入續期（無 migration）：refresh token 只經 `/api/auth/web-session/start` 交給 Worker，加密後存於 HttpOnly `__Host-cj-web-session`（SameSite=Strict、瀏覽器工作階段），前端 sessionStorage 不再保存；續期請求須帶 `X-CJ-Web-Session: 1`，首次登入滿 12 小時強制重新登入，非 LINE 身分或 user id 不符一律拒絕並清除 cookie。
- `202609230003_liff_session_vault.sql`：LIFF 持久登入以 LINE sub 為鍵保存加密 refresh token；RLS＋deny policy，anon／authenticated 無任何表權限，僅 Worker service_role 讀寫。
- `202609240001_product_gallery_showcase.sql`：商品多圖 `product_images`（service-role-only、排序唯一鍵延後檢查）、商品頁介紹與 Hero 欄位、多圖管理 RPC 僅 service_role 可執行；`products.image_path` 由第一張圖同步。
- `202609250001_cancellation_notification_marker.sql`：`orders.cancellation_notified_at` 與部分索引，讓每小時取消通知掃描只處理尚未交給通知狀態機的訂單；會員無此欄位 UPDATE 權限。
- `202609250002_catalog_column_grants.sql`：`categories`／`products`／`product_variants` 對 anon／authenticated 改為欄位級 SELECT，只開放 `storefront_variants` 與 `replace_member_cart` 用到的欄位；成本、SKU、安全庫存、實際庫存、訂金比例不再能以公開 anon key 查詢。套用後已在正式 DB 以 anon／authenticated 角色實測：型錄 view 全欄位可讀（3 筆上架規格）、讀 `cost`／`sku`／`stock_on_hand`／`select *` 皆為 permission denied、會員購物車驗證查詢可執行、service_role 仍可讀全部欄位。
- `202609250003_drop_legacy_rpcs.sql`：刪除 `create_pending_order`、`create_discounted_order` 與 `admin_create_product` 13／14／15 參數舊 overload（套用前確認正式 DB 無函式、排程或 view 引用）。套用後以必定回滾的交易在正式 DB 實測：service_role 以 Worker 的 16 個具名參數與 13 個位置參數皆可建立商品、非管理員 actor 回 `ADMIN_REQUIRED`、authenticated／anon 直接呼叫為 permission denied、`create_pending_order` 已不存在；回滾後正式 DB 無任何測試商品、分類或 audit row。
- **Migration 紀錄對齊（2026-09-24，無 schema 變更）**：正式 DB 原有 44 列以套用時間戳為版本、19 支早期 migration 沒有紀錄。先以唯讀稽核確認：本機從零套用 63 支 migration 與正式 DB 的欄位、約束、索引、view、trigger、RLS、權限、排程、bucket 結構指紋全部相同；60 支函式屬性與權限相同，本體差異只有 CRLF 換行（9 支）、註解（2 支）與 `calculate_shipping_fee`（正式 DB 為 `select 0`，唯一呼叫者已先檢查配送方式，無法觸發差異）。之後在單一交易把 44 列版本改為檔名版本（`statements`／`created_by` 不變，指紋前後相同）並補 19 列（`statements` 留空）；對齊後 `npm run db:history-sql` 唯讀檢查 0 列。詳細與新舊版本對照見 `docs/history/MIGRATION_HISTORY_ALIGNMENT_2026-09-24.md`。
- `202609250004_unify_notification_deliveries.sql`：LINE／Telegram 通知紀錄合併為 `notification_deliveries`（`channel` 區分、RLS＋deny policy、anon／authenticated 無表權限），5 支通知 RPC 簽名與回傳不變並改為靜態 SQL，Worker 不需重新部署。套用前唯讀預檢：兩表共 722 列、無處理中紀錄、id 不重疊、無其他物件依賴舊表。套用後比對：id 指紋與內容指紋（event_key、recipient、event_type、sent_at、attempt_count、payload）與套用前完全相同；唯一差異是 1 筆狀態機上線前的 Telegram `pending` 改為不自動重試的 `failed`。以必定回滾的交易實測：claim／complete、舊 token 無法完成、已送出不再 claim 且不改 payload、後台列表遮罩與排序正常；service_role 不能執行 `purge_notification_deliveries`，會員不能 claim 或讀表；回滾後無殘留。每日 pg_cron `chaoji-purge-notification-deliveries`（19:30 UTC）刪除 180 天前已送出或不再重試的失敗紀錄（目前 0 列符合）。migration 紀錄已以 `npm run db:history-sql -- align` 對齊，唯讀檢查 0 列。
- `202609250005_member_point_ledger_rls.sql`：`point_ledger` 新增 `members view own point ledger`（authenticated、本人列）並只授權前台欄位（不含 `actor_id`）。對應 Worker（commit 5e40a7e）改以會員 JWT 讀訂單與點數紀錄，**尚待部署**；migration 已先套用，舊 Worker 不受影響。套用後以必定回滾的交易在正式 DB 以真實會員身分實測：本人點數 26/26 可讀、不加條件也只看到本人 26 列（全表 69 列）、訂單只看到本人 28 筆；讀 `actor_id`、新增點數、anon 讀取皆 permission denied。migration 紀錄已對齊（65 列、全部為檔名版本）。
- `202609250006_taipei_order_number.sql`：`create_delivery_order`（8 參數核心）函式層級 `timezone = Asia/Taipei`（`search_path` 仍為空）。套用後以必定回滾的交易在正式 DB 以真實會員建單：訂單編號 `CJ-260925-031630-…` 與台灣時間一致（UTC 會是 `CJ-260924-191630`），建單後連線時區仍為 UTC；回滾後無新增訂單或保留量。migration 紀錄已對齊（66 列）。同批 Worker／前端修正（commit 951b7c0：生日券通知改查近 48 小時、低庫存以台灣日期去重、優惠券日期以台灣時間顯示與輸入、LINE Flex `alignItems` 改為 `flex-start`）**尚待部署**；LINE Flex 未實際發送驗證（LINE 免費額度用完），以離線規格測試檢查。
- `202609250007_unified_low_stock.sql`：低庫存唯一定義 `low_stock_variants`（商品與規格都上架中且庫存 ≤ 安全庫存，僅 service_role），`admin_dashboard_stats.lowStock` 改用它計數。套用後以必定回滾的交易在正式 DB 實測：套用當下 0 列；把 1 個上架規格與 1 個下架規格庫存設為 0 後，函式與後台統計皆為 1（下架者不計）、上限參數有效、會員呼叫為 permission denied；回滾後上架規格 4 個、低庫存 0。migration 紀錄已對齊（67 列）。對應 Worker（commit 8d99b11：後台清單與 Telegram 低庫存通知改用同一定義）**尚待部署**。

套用後需以 `supabase/verify_schema.sql` 唯讀確認函式簽名、notification claim token、退貨驗收表與管理概況 count RPC，再執行 Supabase Security Advisors。不要把本機 dry-run 視為 migration 已套用或 production 已更新。

**Security Advisors 結果（2026-09-24 唯讀執行）**：
- `authenticated_security_definer_function_executable`（5 項）：`create_delivery_order`（10 參數版）、`submit_order_payment`、`member_point_balance`、`member_available_coupons`、`current_user_is_admin`。皆為會員前台功能刻意開放給 `authenticated`；已核對函式內皆以 `auth.uid()` 判斷呼叫者、`search_path` 為空、未授權 `anon`。8 參數版 `create_delivery_order` 是 10 參數版呼叫的核心實作（不是舊版），只剩 `service_role`／`postgres` 可直接執行。屬預期，不需處理；日後修改這些函式須維持以 `auth.uid()` 限定本人資料。
- `auth_leaked_password_protection`：Free 方案無法開啟，見下方 A 節（Email provider 已關閉、只允許 LINE）。
- `verify_schema.sql`（2026-09-24 唯讀執行於正式專案 `csiviervpnxdzyfcuamm`）：套用 `202609250004` 後 110 項檢查全部為 true（通知改為單表：新表存在、舊表已移除、唯一鍵、RLS／deny policy／API 角色無權限、通知函式無動態 SQL、purge 函式僅排程可執行與每日排程存在）；migration 紀錄對齊後為 104 項（新增 `migration_history_uses_repo_versions`：紀錄全部為 12 碼檔名版本）；套用 `202609250003` 時為 103 項：`202609250002` 新增型錄底層表無整表 SELECT、`product_variants` 私有欄位不對 API 角色開放、anon 可讀 `storefront_variants` 三項；`202609250003` 將舊 RPC 由「存在」改為「已移除」，並新增 8 參數 `create_delivery_order` 核心存在且 API 角色不可直接執行。先前一輪補上 `202609230003`、`202609240001`、`202609250001` 的檢查：LIFF vault 與 `product_images` 的 RLS／deny policy／API 角色無表權限、多圖 RPC 僅 service_role 可執行、`audit_logs_action_check` 同時允許 `retry` 與 `delete`、`storefront_variants` 維持 `security_invoker` 並含 Hero 欄位，以及資料一致性 `products.image_path` 等於第一張商品圖。之後每次變更 schema 都要重跑並更新此列。

Audit 驗證方案：以隔離測試管理員執行商品／規格／分類／收款帳戶／優惠券／生日券／點數設定 mutation，確認每次資料變更與 audit row 同 transaction；一般會員、anon 與偽造 actor 應被 RPC 拒絕。對 `audit_logs` 執行 UPDATE、DELETE、TRUNCATE 應分別被權限或 `AUDIT_LOG_IMMUTABLE` 拒絕。若商品圖片 binary 上傳成功但後續 DB pointer 更新失敗，需依 storage 與 audit 結果人工補償；此跨服務操作不宣稱單一 transaction。

## A. Supabase Auth：Email／洩漏密碼防護

目前組織方案為 Free；Supabase 官方說明 leaked-password protection 僅 Pro 以上方案可用。若維持 Free，請採用「只允許 LINE」的設定：

1. Supabase Dashboard → Authentication → Providers。
2. 將 Email provider 停用（本商店目前登入入口是 LINE）。
3. Authentication 的 General／Configuration 設定中，關閉公開註冊（若該選項可用）。
4. 儲存後重新登入一次，確認既有 LINE Login 不受影響。
5. 用公開 Auth settings 唯讀確認：`email` 應為 `false`，`disable_signup` 應為 `true` 或符合店主的會員註冊策略。
6. 回到 Supabase Advisors → Security 重新整理；若仍顯示 leaked-password warning，代表 Free 方案無法消除該 advisor，保留此限制紀錄即可。

官方說明：

- [Supabase Password Security](https://supabase.com/docs/guides/auth/password-security)
- [Supabase Auth](https://supabase.com/docs/guides/auth)

Worker 也已加入 provider allowlist；目前 Email provider 已關閉，非 LINE identity 仍不能使用商店會員／訂單 API。

## B. 管理員登入（LINE＋is_admin，無 MFA）

本商店目前不啟用 Supabase MFA。Worker 每次管理 API 請求都會：

1. 先用 Supabase Auth 驗證 Bearer token。
2. 僅接受 LINE／`custom:line-web` provider identity。
3. 以 service role 讀取 `profiles.is_admin` 與 `profiles.line_user_id`，要求兩者都符合目前登入的 LINE identity。
4. 由資料庫 trigger 與 column grant 阻止會員修改 `line_user_id`、`is_admin`。

這是單一登入因子，無法防止已被竊取的 LINE 帳號或工作階段；管理員應使用不同 LINE 帳號、裝置鎖定與 LINE 官方安全設定。若未來要恢復 MFA，需重新加入 TOTP／Passkey enrollment 與 challenge 流程，不能只切換 Dashboard 選項。

## C. Cloudflare Rate Limiting

正式網址為自訂網域 `super-fun.767780.xyz`（767780.xyz zone）。商店 API 的限流由 Worker 執行：Worker 已改用 Cloudflare Workers Rate Limiting API，限制會在程式進入指定 API 後執行。

部署前不可刪除 `wrangler.jsonc` 的三個 `ratelimits` binding。

767780.xyz zone 另有店主自建的兩條規則（2026-10-09 調整）：WAF 自訂規則封鎖非台灣流量，但放行 `cf.client.bot`、ASN 38631（LINE）與 ASN 32934（Facebook），否則 LINE／FB 分享預覽抓不到縮圖；速率限制只比對掃描路徑（`/wp-`、`.php`、`/.git`、`/.env` 等，每 IP 10 秒 5 次）。速率限制的 `contains` 不支援 `*` 萬用字元，不要比對商店本身的頁面或 `/api/`：行動網路多人共用 IP，容易誤擋顧客。外部工具（PageSpeed、OG 檢查器）回 403 時先查 Security → Events。

官方說明：[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## 回復程序（部署或 migration 出錯時）

- 單一 deployment owner 執行回復，避免多個代理平行操作互相覆蓋；完成後在本清單記錄實際 Version ID／migration 檔名與處理結果。
- **Worker 回復**：先 `$env:WRANGLER_WRITE_LOGS='0'`，以 `npx wrangler deployments list --json` 找出前一個正常版本的 Version ID，再執行 `npx wrangler rollback <version-id>` 回退。回復前先確認舊版 Worker 相容目前資料庫 schema（Worker 回復不會復原已套用的 migration，若新 migration 已改變欄位或移除舊 RPC，舊版程式碼可能無法運作）。回復後依 AGENTS.md 的 post-deploy smoke 檢查（`deployments list --json` 確認流量 100%、Node `fetch` 驗證 health／config／catalog／首頁與本次相關 route）。
- **資料庫回復**：migration 一律只能往前疊加，不可重跑或修改已套用檔案。若已套用的 migration 造成問題，撰寫新的 incremental migration 修正（依 AGENTS.md 部署流程走完整檢查與 `test:db`）；執行有風險的 migration 前，先在 Supabase Dashboard 確認專案的 backup／point-in-time recovery 可用狀態，作為復原的最後手段，不假設特定方案功能已啟用。
- 若懷疑資料已損壞且無法以新 migration 修正，先停止繼續套用變更並回報範圍，再由店主／有權限者依 Supabase Dashboard 的備份功能評估還原，不在本清單自行執行資料庫還原。
- **每週資料備份（R2）**：Worker 每週一台灣 03:00（cron `0 19 * * 0`，`src/database-backup.ts`）以 service role 呼叫 `backup_snapshot()`，在同一個資料庫快照內讀出營運資料表（訂單與明細不會錯開），原樣存到私有 bucket `chaoji-backups` 的 `weekly/<台灣日期>/snapshot.json`（`tables.<資料表>` 為該表所有列）。bucket 不可設定公開網域或 r2.dev；生命週期規則刪除 90 天前的 `weekly/` 物件。
  - 不含：`auth.users`（不在 public schema）、`liff_session_vault`、`member_cart_items`、`line_low_stock_states`、`notification_deliveries`。還原後會員需重新以 LINE 登入，`profiles.id` 仍需對應到同一個 auth 使用者。
  - 檢查：Cloudflare Dashboard → R2 → `chaoji-backups` 確認每週有新檔案；失敗只寫 Worker log（`資料備份失敗`），不會產生當週檔案。
  - 還原：由店主／有權限者評估後，先還原到測試專案驗證，再依外鍵順序（categories → products → product_variants → … → orders → order_items）以 SQL 匯入；不在正式資料庫直接覆寫。

## D. 上線前人工驗收

- 用兩個不同 LINE 會員測試：只能看到自己的訂單／點數／優惠券。
- 未加入官方 LINE、沒有 provider token、Email account 都不能建立訂單。
- 重複點擊結帳、重複 variant、短時間多筆訂單會被限制。
- `pending_review` 逾期後 reservation 會釋放。
- 未上架商品的圖片 URL 回傳 404，不可透過已知 UUID 讀取。
- 管理員可收到必要通知，但不能從會員 API 讀取管理 log、庫存異動或其他會員資料。
- 每次安全 migration 後重新執行 Supabase Security Advisors，並保留結果截圖／紀錄。
