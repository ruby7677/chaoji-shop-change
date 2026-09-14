# 潮吉好頑｜安全營運操作清單

本清單記錄目前已完成的程式／資料庫防護，以及需要店主在 Supabase／Cloudflare 控制台完成的操作。不要把任何 secret、token、LINE user ID 或會員個資寫入本文件。

## 已完成並已部署

- Supabase `security_hardening`：LINE 好友驗證時間戳、訂單／庫存限制、限購、逾期 reservation 釋放、舊 RPC 撤銷、最小 table grants、SECURITY DEFINER 空 `search_path`。
- Supabase `public_catalog_security`：private schema 聚合可售庫存；未公開 reservation 明細不直接暴露給 anon。
- Supabase `explicit_deny_policies`：service-role-only 表建立明確 deny policies；security advisor 的 RLS 無 policy INFO 已清除。
- Worker provider allowlist：`LINE_AUTH_ENABLED=true` 時拒絕非 LINE identity 的 Supabase token。
- Worker Rate Limiting API：
  - `API_ORDER_RATE_LIMITER`：每會員 10 次／60 秒。
  - `API_MEMBER_RATE_LIMITER`：每會員好友驗證／付款 30 次／60 秒。
  - `API_ADMIN_RATE_LIMITER`：每位管理員 API 20 次／60 秒。
- Worker 安全標頭：CSP、HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy。
- 最新 Worker：`deployed-admin-mfa-v2`（Version ID `55e52841-dcca-4a4e-9c33-7cd4acf4cce1`）。

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

Worker 也已加入 provider allowlist，因此即使 Email provider 暫時未關閉，非 LINE identity 不能使用商店會員／訂單 API。

## B. 管理員 MFA

請注意：Supabase 組織 MFA 只保護 Supabase Dashboard，不等於商店後台的三位管理員登入已完成 MFA。

目前商店使用 LINE Login，前端已提供管理員 TOTP enrollment／challenge 頁面；Supabase 組織 MFA 仍只保護 Supabase Dashboard，不等於商店後台的三位管理員登入已完成 MFA。

安全上線順序：

1. 先為三位管理員規劃各自的驗證器（1Password、Authy、Google Authenticator 或 Apple 密碼）。
2. 管理員登入後開啟「會員資料 → 管理驗證器」，使用 Supabase Auth MFA TOTP API 完成註冊。
3. 三位管理員各自完成註冊並以測試帳號驗證。
4. Worker `requireAdmin` 已支援 AAL2（`aal2`）要求；目前 `ADMIN_MFA_REQUIRED=false`，確認三位管理員都能登入後，再將它設為 `true`（Cloudflare Worker variable）並重新部署。
5. 測試一般會員不能進入後台、AAL1 管理員不能操作後台、AAL2 管理員可以操作後台。

官方說明：[Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa)

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
