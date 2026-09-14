# Supabase 與 LINE Login 設定

## 1. 套用資料庫

1. 開啟 Supabase Dashboard → SQL Editor → New query。
2. 貼上並執行 `supabase/migrations/202609080001_initial_schema.sql`。
3. 另開一個 query，貼上並執行 `supabase/seed.sql`。
4. 若既有專案已完成前述 migration，接著只執行尚未套用的 migration；目前通知 migration 為 `202609100007_line_notifications.sql`，訂單確認補強 migration 為 `202609110001_admin_order_completion.sql`，取貨方式 migration 為 `202609110002_delivery_methods.sql`，運費改由客服到貨後通知 migration 為 `202609110003_remove_shipping_calculation.sql`，到店支付流程為 `202609110004_store_payment.sql`，到貨後尾款／實際運費確認為 `202609110005_final_payment_workflow.sql`，函式權限加固為 `202609110006_harden_function_privileges.sql`，前台商品詳情／規格欄位為 `202609110007_storefront_product_details.sql`，商品限購設定為 `202609110008_purchase_limit_management.sql`，無 MFA 管理員 identity guard 為 `202609140004_no_mfa_identity_guard.sql`。不要重跑已成功執行的 migration。
5. 重新啟動網站後，`GET /api/catalog` 應回傳 Supabase 內的兩筆示範商品。

僅有 Project URL、anon key、service role key 無法從外部執行任意 SQL；因此初次 migration 必須使用 SQL Editor、Supabase CLI 或資料庫連線密碼完成。

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

## 3. 設定網站導向網址

Supabase Dashboard → Authentication → URL Configuration：

- Site URL：正式 Cloudflare 網域。
- Redirect URLs：加入本機與正式網址，例如 `http://localhost:8787/**` 與 `https://你的網域/**`。

## 4. Cloudflare secrets

正式部署時在 Cloudflare Worker 設定：

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`（LINE Developers → Messaging API → Channel access token）
- `LINE_ADMIN_USER_IDS`（逗號分隔的管理員 LINE user ID；可從 `profiles.line_user_id` 取得）
- `LINE_NOTIFY_ENABLED`（`true` 啟用，`false` 暫停通知）

部署後可由管理員登入後台，在「營運概況」按「測試 LINE 通知」。這會只發送測試訊息給 `LINE_ADMIN_USER_IDS`，不建立訂單、不扣庫存；兩個 LINE 權杖與管理員 ID 請放在 Cloudflare Worker Secrets，不要放入 `wrangler.jsonc` 的公開變數。

`SUPABASE_SERVICE_ROLE_KEY` 只能由 Worker 使用，不得出現在 `public`、瀏覽器原始碼或 Git。

Cloudflare Cron 會每小時執行生日券發送與低庫存檢查；生日券發送函式具冪等性。管理員也可在後台「優惠券」分頁按「立即執行生日券發送」。

## 5. 管理員權限

管理員權限由 `public.profiles.is_admin` 控制，會員無法透過前台自行提升權限。新增管理員時，先讓該 LINE 帳號登入並完成會員資料，再由受信任的 Supabase SQL Editor 將該會員設為管理員；Worker API 會在每次管理操作時再次驗證此旗標。

本專案採用無 MFA 模式：Worker 會同時比對目前登入的 LINE provider identity 與 `profiles.line_user_id`，並要求 `profiles.is_admin = true`。`line_user_id` 與 `is_admin` 由服務端維護，會員只能更新自己的聯絡資料。
