# Supabase Phase 11–12 回歸與流量驗收

驗證日期：2026-09-19（UTC）

本次只執行公開 API 的低流量唯讀驗收與 Supabase metadata／Advisor 查詢；沒有建立訂單、付款回報、庫存 reservation、點數、優惠券、通知 log，也沒有重置 `pg_stat_statements`。

## Phase 11：正式可安全執行的回歸

### 本機／Worker source checks

- `node --check public/app.js`：通過。
- `npm run typecheck`：通過。
- `git diff --check`：通過；僅有既有 CRLF conversion warning，沒有 whitespace error。
- 通知分流 deterministic test：通過。
  - 到店取貨完成產生「已完成取貨」。
  - 宅配／賣貨便完成回傳 `null`，不產生完成通知。
  - 收件者為會員 LINE 與管理員 Telegram。

### 正式 Worker 公開唯讀 smoke

Worker：`https://chaoji-haowan-shop.ruby7677.workers.dev`

| Request | 次數 | 結果 | 觀察 |
| --- | ---: | --- | --- |
| `/api/health` | 1 | 200 | `no-store`；database flag 正常 |
| `/api/config` | 1 | 200 | `public, max-age=300, s-maxage=300`；383 bytes |
| `/api/catalog` | 3 | 200 | 每次 1,608 bytes；`no-store`；商品結構一致 |
| 已上架商品圖片 GET | 1 | 200 | 43,449 bytes；`public, max-age=31536000, immutable` |

### Supabase metadata／Advisor regression

- 遠端 migration 清單包含 Phase 7–10：
  - `phase7_expired_orders_cron_frequency`
  - `phase8_hot_path_indexes`
  - `phase9_rls_initplan`
  - `phase10_revoke_legacy_delivery_rpc`
- `cron.job` 唯讀確認：
  - `chaoji-release-expired-orders`：`*/5 * * * *`，active。
  - `chaoji-issue-birthday-coupons`：`0 1 * * *`，active。
- RLS Advisor：`auth_rls_initplan=0`、`multiple_permissive_policies=0`。
- RLS policy 唯讀確認使用 `(select auth.uid())`，且 `member_cart_items` 只保留管理自己的 ALL policy。
- Performance Advisor 仍有 12 筆低優先級 unindexed-FK INFO 與 11 筆 unused-index INFO；目前資料量小，不能視為 hot-path migration 失敗。
- Security Advisor 仍有 4 筆 authenticated SECURITY DEFINER WARN（現行登入／下單／付款／優惠券 call path），以及 Supabase Free 方案的 leaked-password protection WARN。
- SECURITY DEFINER 函式目前均有空 `search_path` 設定；舊版 8 參數 `create_delivery_order` 已不授予 authenticated，現行 10 參數版本仍保留。

### 仍需額外授權／隔離 fixture 的項目

下列項目不能在正式資料上假裝通過，本次維持 `SKIP`：

- anon、member A、member B、admin 的真實 JWT RLS allow／deny 矩陣。
- inventory reservation 併發下單／釋放測試。
- `line_user_id IS NULL` 的首次 identity bind 寫入測試。
- 訂單、付款、點數、庫存與通知副作用的交易回歸。
- 圖片上傳／下架後的 cache invalidation 寫入測試。

這些測試需要一次性可回復的 staging／branch fixture，以及明確的資料寫入授權；目前沒有為正式 project 建立測試資料。

## Phase 12：pg_stat_statements 固定低流量 before／after

### Catalog query

以相同 `queryid=7446038463823754192` 比較三次 `/api/catalog` 前後 snapshot：

| 指標 | Before（03:48:14 UTC） | After（03:48:43 UTC） | Delta |
| --- | ---: | ---: | ---: |
| calls | 44 | 47 | +3 |
| total_exec_time | 194.037 ms | 203.838 ms | +9.801 ms |
| rows | 44 | 47 | +3 |
| shared blocks hit | 5,733 | 5,968 | +235 |
| shared blocks read | 2 | 2 | +0 |

Delta 與三次公開 catalog GET 一致；沒有額外的寫入 query。

### Image query

以 `queryid=3225458324290198001` 比較一次圖片 GET：calls 維持 41、total execution time 維持 5.959 ms。圖片回應為 200，表示本次命中 edge／Worker cache，沒有新增 Supabase Storage metadata query。

### 解讀限制

這是「目前版本固定低流量 smoke 的 before／after delta」，不是 2026-08-25 歷史 baseline 的重新壓測，也不是高流量容量保證。歷史 baseline 仍保留於 `SUPABASE_USAGE_OPTIMIZATION_PHASE1_3.md`，因 stats 未重置且期間有其他操作，不能直接換算改善百分比。

## 結論

- Phase 7–10：migration 與安全 metadata／Advisor 檢查已完成。
- Phase 11：公開唯讀與 source／通知回歸已完成；需要真實身分、交易與併發寫入的部分依安全規則保留 SKIP。
- Phase 12：已完成一次固定低流量的 catalog／image pg_stat before／after delta；尚未宣稱歷史流量或正式交易容量驗收。

## 部署後確認

- Cloudflare Worker Version ID：`c1f15ad0-06dd-4aaf-b16a-2fd337b9111b`
- 部署後 `/api/health`、`/api/config`、`/api/catalog` 均回 200。
- 部署後 catalog 回應 1,608 bytes、`no-store`；config 維持 `public, max-age=300, s-maxage=300`。
