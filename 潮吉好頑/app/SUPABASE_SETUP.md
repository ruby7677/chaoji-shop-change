# Supabase 與 LINE Login 設定

## 1. 套用資料庫

1. **新專案**：依檔名順序執行 `supabase/migrations/` 內全部 migration（SQL Editor 逐檔貼上、Supabase CLI 或資料庫連線皆可），再執行 `supabase/seed.sql` 建立兩筆示範商品。全部 migration 可在空資料庫從頭套用，`npm run test:db` 會實際驗證這件事；seed 也已確認可在全部 migration 之後執行。
2. **既有專案**：先比對遠端 migration history 與本機檔名，只執行尚未套用的 migration，不要重跑已套用的檔案（遠端版本號與本機檔名可能不同，需比對內容）。
3. 套用後執行 `supabase/verify_schema.sql`（唯讀，應全部回傳 true），再執行 Supabase Security Advisors；結果記錄於 `SECURITY_OPERATIONS_CHECKLIST.md`。
4. 重新啟動網站後，`GET /api/catalog` 應回傳 Supabase 內的兩筆示範商品。

僅有 Project URL、anon key、service role key 無法從外部執行任意 SQL；因此初次 migration 必須使用 SQL Editor、Supabase CLI 或資料庫連線密碼完成。

### 各 migration 用途（節錄）

- 本站到店取貨／宅配僅匯款限制請另執行 `supabase/migrations/202609140006_bank_transfer_only_store_pickup.sql`；賣貨便仍保留外部付款流程。
- 預購訂單付款期限請另執行 `supabase/migrations/202609150001_preorder_payment_deadline.sql`；預購 2 小時、現貨 24 小時。
- 若要開啟預購賣貨便，請執行 `supabase/migrations/202609150002_preorder_seller_delivery_bank_transfer.sql`；預購先在本站匯款付訂，到貨後由客服開立賣貨便。
- 現貨與預購分單防護請執行 `supabase/migrations/202609150003_split_mixed_order_guard.sql`；API 也會拒絕混合類型訂單。
- 單筆分批取貨防護請執行 `supabase/migrations/202609150004_single_order_pickup_plan.sql`；新訂單固定以本組商品一併處理。
- 會員購物車資料表請執行 `supabase/migrations/202609150005_member_cart_sync.sql`，再執行 `supabase/migrations/202609150006_member_cart_replace_rpc.sql`；兩份 migration 會啟用 RLS 與會員 JWT 原子同步。
- Telegram 管理員通知紀錄請執行 `supabase/migrations/202609150007_telegram_notification_logs.sql`；管理員與公開角色不可讀取此表。
- Telegram 通知紀錄 deny policy 請執行 `supabase/migrations/202609150008_telegram_notification_deny_policy.sql`。
- 瀏覽器不支援 WebP 轉檔時允許保留原始 JPG／PNG，請執行 `supabase/migrations/202609150009_product_images_original_fallback.sql`；bucket 仍為私有，Worker 仍驗證格式並限制 5MB。
- 商品分類管理請執行 `supabase/migrations/202609150010_category_management.sql`；分類新增／改名／排序／停用由管理後台處理，停用不會影響既有商品。
- 點數退款／取消沖回請執行 `supabase/migrations/202609210001_points_reversal_refund_and_cancel_repair.sql`；此 migration 只補點數帳本邏輯，不會自行改動現有訂單。
- 完整點數餘額請執行 `supabase/migrations/202609220001_member_point_balance_rpc.sql`；前台歷程仍只載入最近 100 筆，餘額由資料庫完整加總。
- 通知送達狀態機請執行 `supabase/migrations/202609220002_notification_delivery_state_machine.sql`；它會加入原子 claim、lease、fencing token 與重試欄位，並將 RPC execute 限定為 `service_role`。外部通知 API 無法提供 exactly-once，只能以 at-least-once 搭配人工查核處理逾時。
- 取消／退貨庫存流程請執行 `supabase/migrations/202609220003_inventory_cancellation_returns.sql`；未扣庫存取消只釋放 reservation，已扣庫存且尚未完成交付的取消反轉 sale；賣貨便已出貨狀態須走退款與實物驗收，驗收後才按可再售數量回補，報廢只留紀錄。此 migration 也提供管理概況 count RPC 與退款驗收 RPC。
- 管理員 audit 與後台搜尋請依序執行 `supabase/migrations/202609220004_audit_logs_admin_search.sql`、`supabase/migrations/202609220005_audit_existing_admin_rpcs.sql`、`supabase/migrations/202609220006_admin_catalog_coupon_inventory_search.sql`；前兩者建立 service-role-only、不可更新／刪除的 `audit_logs` 與白名單管理／搜尋 RPC，後者補上商品、優惠券、庫存清單分頁與完整 options payload。不要直接對商品、規格、分類或收款帳戶使用 service-role REST PATCH。
- `audit_logs` 只允許 service_role 讀取／插入；更新、刪除與 API 角色存取都會被拒絕。可由管理 Worker 的 `GET /api/admin/audit-logs` 唯讀分頁查看，正式後台「稽核紀錄」tab 支援 resource/action 篩選與分頁；部署前先用 `supabase/verify_schema.sql` 確認表、trigger、policy 與函式簽名。
- 通知 claim 修復請執行 `supabase/migrations/202609220007_notification_claim_found_fix.sql`；它不改變既有函式簽名或 claim token fencing，只將動態 UPDATE 的 claim 判定改為 `GET DIAGNOSTICS ROW_COUNT`，避免回傳 `claimed=false` 但實際已進入 processing 的狀態。
- 通知營運後台請執行 `supabase/migrations/202609230001_notification_operations.sql`；它提供 service-role-only 的通知 list／failed requeue RPC，requeue 會與 `audit_logs` 同 transaction 記錄，且不會立即呼叫 LINE／Telegram。
- 通知顯示 context 請執行 `supabase/migrations/202609230002_notification_display_context.sql`；通知列表只對已知訂單事件前綴中的 canonical UUID 回查訂單編號，LINE 對應會員姓名，Telegram 固定顯示管理員 Telegram；生日券、低庫存與測試事件保持訂單編號空白。
- `202609230003_liff_session_vault.sql`：LIFF 持久登入以 LINE `sub` 為鍵保存加密 refresh token，僅 Worker service_role 讀寫（見第 2 節第 19 點）。
- `202609240001_product_gallery_showcase.sql`：商品多圖 `product_images`、商品頁介紹與 Hero 輪播欄位、多圖管理 RPC。
- `202609250001_cancellation_notification_marker.sql`：`orders.cancellation_notified_at`，讓每小時取消通知掃描只處理尚未交給通知狀態機的訂單。
- `202609250002_catalog_column_grants.sql`：`categories`、`products`、`product_variants` 對 anon／authenticated 改為欄位級 SELECT，成本、SKU、安全庫存與實際庫存不再能用公開 anon key 查詢。`storefront_variants` 新增底層欄位時，須以新 migration 補該欄位的 grant，否則前台型錄會回 permission denied（`npm run test:db` 會抓到）。
- `202609250003_drop_legacy_rpcs.sql`：刪除已無呼叫者的 `create_pending_order`、`create_discounted_order` 與 `admin_create_product` 的 13／14／15 參數舊 overload；下單只走 `create_delivery_order`（10 參數版對外、8 參數版為其核心實作，僅 service_role 可直接執行），建立商品只剩 16 參數版。

## 2. 建立 LINE 自訂登入提供者

LINE 的網頁登入 ID Token 使用 HS256，但 LINE 的 OIDC discovery 宣告 ES256；Supabase OIDC 自動探索會因此拒絕網頁登入。請使用 Custom OAuth2 的手動設定，並由 UserInfo endpoint 取得會員資料。

1. 確認 LINE Login Channel 與 Messaging API Channel 位於同一個 LINE Provider。
2. 在 LINE Developers Console 將 LINE Official Account 綁定到 LINE Login Channel；兩者必須位於同一個 Provider，才能在登入同意畫面提供加好友選項。
3. Supabase Dashboard → Authentication → Providers → New provider。
4. 選擇 Manual configuration。
5. Identifier：`custom:line-web`。
6. Display Name：`潮吉好頑 LINE Web`。
7. Issuer：`https://access.line.me`。
8. Authorization URL：`https://access.line.me/oauth2/v2.1/authorize`。
9. Token URL：`https://api.line.me/oauth2/v2.1/token`。
10. UserInfo URL：`https://api.line.me/oauth2/v2.1/userinfo`。
11. JWKS URI：留空。
12. Client ID：LINE Login Channel ID。
13. Client Secret：LINE Login Channel Secret。
14. Scopes：`openid, profile`。
15. 開啟 Allow users without email；本專案不要求 LINE 提供 Email，也不啟用 Supabase MFA。Email provider 維持關閉。
16. 將 Supabase 畫面顯示的 Callback URL 加入 LINE Developers Console 的 Callback URL。
17. Provider 啟用後，確認 `wrangler.jsonc` 的 `SUPABASE_CUSTOM_PROVIDER` 為 `custom:line-web`、`LINE_AUTH_ENABLED` 為 `true`；前端登入會帶入 `bot_prompt=normal`，登入同意畫面可提示加入官方 LINE。
18. 若啟用 LIFF 無感重開登入，正式 Worker 需另外設定 `AUTH_SESSION_SECRET`。請使用至少 32 字元的隨機值，透過 `wrangler secret put AUTH_SESSION_SECRET` 寫入 Cloudflare Secret，不要放進 `wrangler.jsonc` 或 Git。Worker 只會把 Supabase refresh token 加密後存入 HttpOnly/Secure Cookie；瀏覽器 JavaScript 不會持久保存 refresh token。
19. 套用 `202609230003_liff_session_vault.sql` 後，Worker 會改以 LIFF ID Token 驗證過的 LINE `sub` 為鍵，把加密 refresh token 存在 `liff_session_vault`（僅 service_role 可讀寫），並清除舊 Cookie。LINE WebView Cookie 遺失時仍可在頁內恢復登入，不再跳轉 Supabase／LINE OAuth；只有第一次建立會員時需要 OAuth。Migration 尚未套用時自動沿用 Cookie 模式。
20. 一般瀏覽器（非 LINE App）同樣使用 `AUTH_SESSION_SECRET`：LINE 登入回來後，前端把 refresh token 交給 `/api/auth/web-session/start`，Worker 換發一次並確認是 LINE 會員後，加密存進 `__Host-cj-web-session`（HttpOnly、Secure、SameSite=Strict、不設 Max-Age），前端不再保存 refresh token。access token 到期前 1 分鐘由 `/api/auth/web-session/refresh` 換發；關閉瀏覽器即登出，首次登入滿 12 小時後 Worker 拒絕續期、需重新 LINE 登入。這條路徑不寫入 `liff_session_vault`，與 LINE App 的登入互不影響。
20. LINE Developers Console 的 LIFF Endpoint URL 請設為站台根網址（例如 `https://<網域>/`），並以 `https://liff.line.me/<LIFF_ID>` 分享，不附加路徑；Endpoint 與開啟路徑不同時，LIFF SDK 會用 `liff.state` 再整頁導向一次，造成閃爍。LIFF 的 Size 建議 Full。

## 3. 設定網站導向網址

Supabase Dashboard → Authentication → URL Configuration：

- Site URL：正式 Cloudflare 網域。
- Redirect URLs：加入本機與正式網址，例如 `http://localhost:8787/**` 與 `https://你的網域/**`。

## 4. Cloudflare secrets

正式部署時在 Cloudflare Worker 設定：

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`（會員訂單／生日券通知與好友檢查）
- `LINE_NOTIFY_ENABLED`（`true` 啟用會員 LINE 通知，`false` 暫停）
- `TELEGRAM_BOT_TOKEN`（由 Telegram `@BotFather` 建立；僅存於 Worker secret）
- `TELEGRAM_ADMIN_CHAT_IDS`（逗號分隔的私人或群組 chat ID；每位管理員須先與 Bot 開始對話）
- `TELEGRAM_NOTIFY_ENABLED`（`true` 啟用管理員 Telegram 通知，`false` 暫停）

部署後可由管理員登入後台，在「營運概況」按「測試 Telegram 通知」。這只會傳送測試文字，不建立訂單、不扣庫存。Bot token、chat ID 與 LINE 權杖都必須放在 Cloudflare Worker Secrets，不要寫入 `wrangler.jsonc` 或公開前端。

`SUPABASE_SERVICE_ROLE_KEY` 只能由 Worker 使用，不得出現在 `public`、瀏覽器原始碼或 Git。

Cloudflare Cron 每 5 分鐘會領取到期的 LINE／Telegram 通知重試；每小時另執行取消訂單通知補掃、生日券發送與低庫存檢查。通知 claim 有 lease 與 fencing token，可避免舊 worker 完成結果覆蓋新 attempt；外部 API 逾時仍可能重複送達，不能宣稱 exactly-once。生日券發送函式具冪等性。管理員也可在後台「優惠券」分頁按「立即執行生日券發送」。

管理員訂單搜尋支援訂單編號、會員姓名／手機與匯款末五碼，狀態篩選包含賣貨便待核對；搜尋、篩選與分頁都由資料庫 RPC 執行，避免只在目前頁面過濾。

### Telegram 管理員通知設定

1. 在 Telegram 開啟官方 `@BotFather`，使用 `/newbot` 建立 Bot，取得 token。
2. 每位管理員先開啟該 Bot 並按「Start」；若使用管理群組，先將 Bot 加入群組並傳送一則訊息。
3. 使用 Bot API `getUpdates` 讀取回傳資料中的 `message.chat.id`；群組 chat ID 通常為負數。請勿把 token 或完整 API 網址貼到公開對話。
4. 將 token 存為 Cloudflare secret `TELEGRAM_BOT_TOKEN`，將一個或多個 chat ID 以逗號分隔存為 `TELEGRAM_ADMIN_CHAT_IDS`。
5. 部署後由後台按「測試 Telegram 通知」；所有 chat ID 都收到訊息才算設定完成。

## 5. 管理員權限

管理員權限由 `public.profiles.is_admin` 控制，會員無法透過前台自行提升權限。新增管理員時，先讓該 LINE 帳號登入並完成會員資料，再由受信任的 Supabase SQL Editor 將該會員設為管理員；Worker API 會在每次管理操作時再次驗證此旗標。

本專案採用無 MFA 模式：Worker 會同時比對目前登入的 LINE provider identity 與 `profiles.line_user_id`，並要求 `profiles.is_admin = true`。`line_user_id` 與 `is_admin` 由服務端維護，會員只能更新自己的聯絡資料。
