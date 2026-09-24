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
  - `API_MEMBER_RATE_LIMITER`：每會員好友驗證／付款 30 次／60 秒。
  - `API_ADMIN_RATE_LIMITER`：每位管理員 API 20 次／60 秒。
- Worker 安全標頭：CSP、HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy。
- 最新 Worker：Version ID `16d93c0c-02e6-458d-be77-55adc2ca1a01`（2026-09-24 部署：每小時取消訂單通知只掃描 `cancellation_notified_at` 為空的訂單，migration `202609250001` 已先套用；之前 `4cee25b2` 為電腦版「管理後台」另開 `/admin` 分頁，權限仍由伺服器檢查、登入資料未改存 localStorage；之前 `f12d9aeb` 為登入過期處理、`d3241da1` 為畫面內確認視窗、`b62ef7b4` 為商品與規格頁改版與 iOS Safari 修正，其間另有首頁輪播版面調整；歷次版本見 `ADMIN_REDESIGN_PLAN.md`、`PRODUCT_SHOWCASE_PLAN.md`）。
- 商品積點 eligibility migration：`product_points_eligibility` 與 `product_points_admin_acl`；新版管理商品 RPC 僅保留 service_role execute，`search_path` 維持空值。

## 已套用 migration（2026-09-22～09-24）

2026-09-24 以 Supabase migration history 核對：以下 migration 皆已套用至正式 DB（遠端版本號與本機檔名不同，以名稱對應），另含 `liff_session_vault`（20260923111528）與 `product_gallery_showcase`（20260923145715）：

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
- `202609250002_catalog_column_grants.sql`（遠端版本 20260924175913）：`categories`／`products`／`product_variants` 對 anon／authenticated 改為欄位級 SELECT，只開放 `storefront_variants` 與 `replace_member_cart` 用到的欄位；成本、SKU、安全庫存、實際庫存、訂金比例不再能以公開 anon key 查詢。套用後已在正式 DB 以 anon／authenticated 角色實測：型錄 view 全欄位可讀（3 筆上架規格）、讀 `cost`／`sku`／`stock_on_hand`／`select *` 皆為 permission denied、會員購物車驗證查詢可執行、service_role 仍可讀全部欄位。

套用後需以 `supabase/verify_schema.sql` 唯讀確認函式簽名、notification claim token、退貨驗收表與管理概況 count RPC，再執行 Supabase Security Advisors。不要把本機 dry-run 視為 migration 已套用或 production 已更新。

**Security Advisors 結果（2026-09-24 唯讀執行）**：
- `authenticated_security_definer_function_executable`（5 項）：`create_delivery_order`（10 參數版）、`submit_order_payment`、`member_point_balance`、`member_available_coupons`、`current_user_is_admin`。皆為會員前台功能刻意開放給 `authenticated`；已核對函式內皆以 `auth.uid()` 判斷呼叫者、`search_path` 為空、未授權 `anon`。舊 8 參數版 `create_delivery_order` 只剩 `service_role`／`postgres`。屬預期，不需處理；日後修改這些函式須維持以 `auth.uid()` 限定本人資料。
- `auth_leaked_password_protection`：Free 方案無法開啟，見下方 A 節（Email provider 已關閉、只允許 LINE）。
- `verify_schema.sql`（2026-09-24 唯讀執行於正式專案 `csiviervpnxdzyfcuamm`）：套用 `202609250002` 後 103 項檢查全部為 true（新增型錄底層表無整表 SELECT、`product_variants` 私有欄位不對 API 角色開放、anon 可讀 `storefront_variants` 三項）。先前一輪補上 `202609230003`、`202609240001`、`202609250001` 的檢查：LIFF vault 與 `product_images` 的 RLS／deny policy／API 角色無表權限、多圖 RPC 僅 service_role 可執行、`audit_logs_action_check` 同時允許 `retry` 與 `delete`、`storefront_variants` 維持 `security_invoker` 並含 Hero 欄位，以及資料一致性 `products.image_path` 等於第一張商品圖。之後每次變更 schema 都要重跑並更新此列。

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

目前商店使用 `workers.dev` 網址，沒有 custom domain／Worker route；因此沒有建立 zone-level `/api/*` 規則。Worker 已改用 Cloudflare Workers Rate Limiting API，限制會在程式進入指定 API 後執行。

部署前不可刪除 `wrangler.jsonc` 的三個 `ratelimits` binding。若未來改用正式網域，仍可額外在該 zone 建立 WAF／Ruleset rate-limit 規則，但要先確認只匹配商店 hostname，不要套到同一 zone 的其他服務。

官方說明：[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## D. 上線前人工驗收

- 用兩個不同 LINE 會員測試：只能看到自己的訂單／點數／優惠券。
- 未加入官方 LINE、沒有 provider token、Email account 都不能建立訂單。
- 重複點擊結帳、重複 variant、短時間多筆訂單會被限制。
- `pending_review` 逾期後 reservation 會釋放。
- 未上架商品的圖片 URL 回傳 404，不可透過已知 UUID 讀取。
- 管理員可收到必要通知，但不能從會員 API 讀取管理 log、庫存異動或其他會員資料。
- 每次安全 migration 後重新執行 Supabase Security Advisors，並保留結果截圖／紀錄。
