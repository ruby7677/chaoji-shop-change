# Supabase 流量優化 Phase 1–10

## Baseline

本輪以 2026-08-25 的 `pg_stat_statements` reset 為比較基準；不在本次工作重置或套用遠端 SQL。已知 query fan-out／呼叫量基線如下（來自既有觀測紀錄）：

| 觀測項目 | Baseline calls |
| --- | ---: |
| identity `profiles` UPDATE | 1,248 |
| admin dashboard fan-out | 349 / resource |
| public catalog | 457 |
| product image metadata | 492 |
| points／coupons | 281 |
| cart replace | 131 |
| cancel cron | 11,627 |

上述數字是比較基線，不代表本輪已重新讀取或重置遠端統計；本輪禁止部署、套用 migration、建立訂單、庫存／付款寫入與通知發送。

## 本輪實作

### Phase 1：明確 identity sync

- `requireUser()` 不再於每次會員或管理 API 呼叫時 PATCH `profiles`。
- 新增 `POST /api/member/identity-sync`；執行 `requireUser()` 後只讀 Supabase Auth provider 的 `identities[].identity_data`，不使用可編輯的 `user_metadata`。
- 寫入條件保留 `id = user.id` 且 `line_user_id IS NULL`，因此既有 LINE 綁定不會被覆蓋；`requireAdmin()` 的 `is_admin` 與 provider LINE ID mismatch 拒絕仍保留。
- `public/app.js` 在同一 session 以 `sessionStorage` 加 user-id guard 最多呼叫一次；同步錯誤為 best-effort，不會讓 catalog 或登入流程失敗。

### Phase 2：後台 section lazy loading

- 保留不帶 query 的 `GET /api/admin/dashboard` 相容路徑。
- 新增 `section=overview|orders|members|products|inventory|discounts|settings` 分支；overview 只取統計所需的最小資料，不載入 11 組完整管理資料。
- orders/history/points/members/inventory/products/coupons 等查詢均加上安全 `limit`。
- 前端採 partial merge、`adminSectionLoaded` 與 `adminSectionInFlight` guard；點擊 tab 才首次載入，重返同一 tab 不會重複下載全量 dashboard。現有七個 UI tab 保留，其中 `accounts` 對應 API 的 `settings` section。
- 訂單、商品、庫存、會員點數、優惠券與帳戶 mutation 只 refresh 受影響 section；權限、admin rate limit、DOM selector、優惠券流程及既有交易邏輯未改動。

### Phase 3：catalog／image cache

- `publicCatalog()` 改以明確必要欄位查詢 `storefront_variants`，不再使用 `select=*`；即時 stock 仍直接取 view，沒有 shared catalog cache。
- 商品圖片 endpoint 先以已驗證的上架商品 metadata 找私有 bucket object，再串流回應；成功回應才寫入 `caches.default`。edge cache key 會正規化為商品 ID 的 deterministic path（忽略版本 query），而 `updateProduct` 的上架／下架變更與圖片 upload 都 purge 該 key，避免舊版本 URL 在下架後命中 shared cache。service role 仍只存在 Worker，安全 headers、Content-Type、streaming body 與 `public, max-age=31536000, immutable` 保留。
- 前台 catalog 以 `image_updated_at` 產生圖片版本 query；更新圖片會使用新版本 URL，同時由 Worker purge 舊的 deterministic key。未上架或無圖不會寫入圖片 cache。

### Phase 4：安全 runtime config cache

- `json()` 仍以 `Cache-Control: no-store` 作為所有 API 的預設；僅 `GET /api/config` 覆寫為 `public, max-age=300, s-maxage=300`。
- `/api/config` 回應只包含 Supabase URL／anon key、provider 與 auth flags，沒有會員、管理員、訂單或即時庫存資料；`/api/catalog` 與所有會員／管理員／訂單 API 仍維持 `no-store`。既有 security headers 未移除。

### Phase 5：會員狀態 TTL 與請求合併

- `public/app.js` 以記憶體內、member-scoped cache 保存點數／優惠券 12 分鐘，並以 in-flight guard 合併同一會員的並行請求；`loadMember()` 初次載入，`openCheckout()` 只在 cache 過期時重新取得，不再每次開啟結帳 modal 都打 `/api/member/points`。
- 建單成功後以 `loadPoints({ force: true })` 更新點數／優惠券；付款回報不刷新點數。LINE 好友狀態以 15 分鐘 member-scoped TTL 與 in-flight guard 快取；結帳沿用快取，使用者按「重新檢查」才以 `force: true` 呼叫 API，保留 login token 與伺服器端驗證／TTL 語意。
- 新的 LINE Login callback、登入失效／session 清除與會員 ID 變更都清空兩組 cache；cache 不寫入 shared storage，也不對 member endpoint 加 shared cache header。

### Phase 6：會員購物車 last-write-wins 與 hash 去重

- `public/app.js` 以只含 `variant_id`／`quantity`、按 `variant_id` 排序的 deterministic hash 追蹤 `lastSyncedCartHash`；與已同步狀態相同時不發送 PUT。
- 購物車同步 debounce 調整為 750ms；debounce 尚未送出時只保留最新 snapshot，不再把每次變更排成完整 PUT queue。
- 舊 PUT 仍在進行時，完成後只檢查並送出目前最新且 hash 不同的狀態一次；`syncMemberCartNow()` 會 flush 最新狀態但仍去除相同 hash。
- `loadMemberCart()` 合併訪客與會員購物車後比較 remote／merged hash，只有實際不同才以既有 `/api/cart` replace 流程同步；訪客 cart、跨登入合併、`cartSyncUserId` 與原子 replace RPC 語意保留。
- login callback、session 失效／清除與會員 ID 變更會清除 hash、pending snapshot 與 in-flight guard；購物車資料只留在前端記憶體／既有 sessionStorage，不進 shared cache。

### Phase 7：到期訂單清理與生日券工作分工

- 新增 `supabase/migrations/202609180001_phase7_expired_orders_cron_frequency.sql`，以 `cron.unschedule`／`cron.schedule` 保留 `chaoji-release-expired-orders` job 名稱與 `select public.cancel_expired_orders();` command，頻率由每分鐘 `* * * * *` 調整為每 5 分鐘 `*/5 * * * *`。先取消同名 job 再重建，migration 可重複安全執行；既有 migration 未修改。
- `src/index.ts` 的 `runScheduledNotifications()` 不再由 Worker 每小時呼叫 `issue_birthday_coupons`；生日券建立保留給 Supabase 每日 pg_cron job。Worker 的 `notifyBirthdayCoupons` LINE 發送通知、取消訂單通知與低庫存通知流程保留。
- Wrangler Worker cron 維持每小時 `0 * * * *`，未更動訂單、付款、庫存、點數或優惠券商業規則。Phase 7 migration 已套用遠端；Worker cron 與 Supabase pg_cron 的職責分工已由唯讀查詢確認。

## 驗證

已在 `app/` 執行並通過：

- `node --check public/app.js`
- `npm run typecheck`
- `git diff --check`（僅既有 CRLF conversion warning，無 whitespace error）
- 以 source-level deterministic hash／最新 snapshot 路徑檢查 Phase 6；未用瀏覽器送出 PUT，也未以真實會員資料量測 request count。
- Phase 7 另執行 `npm run typecheck` 與 `git diff --check`；後續已以 Supabase migration／`cron.job` 唯讀查詢確認遠端 job 為每 5 分鐘，未手動觸發 cron。

Phase 1–7 初始實作輪次當時未部署、未執行遠端 SQL／migration，也未執行會寫入訂單／付款／庫存／購物車／通知的 endpoint；該段歷史驗證因此將 health、catalog、identity matrix、admin Network trace、warm/cold image cache 與 pg_stat after snapshot 記為 `SKIP`。目前最新的公開唯讀 smoke 與 pg_stat delta 請以 `SUPABASE_PHASE11_12_REPORT.md` 為準。

### Phase 8–10：DB indexes、RLS 與 SECURITY DEFINER

- 已新增三個增量 migration，詳見 `SUPABASE_PHASE8_10_REPORT.md`。
- 三個 Phase 8–10 migration 已套用遠端；尚未以正式會員／管理員 token 執行 RLS 或 concurrency 測試。
- Phase 10 只撤銷未被現行 Worker 使用的舊版 8 參數 `create_delivery_order`；現行 10 參數版本保留。

## Phase 11–12 最新狀態

公開唯讀 smoke、source／通知 regression，以及固定低流量的 `pg_stat_statements` catalog／image before／after delta 已完成；完整結果與數值見 `SUPABASE_PHASE11_12_REPORT.md`。仍需隔離 fixture 與額外授權的 RLS 角色矩陣、inventory concurrency、first-bind identity write、交易／通知副作用與圖片失效寫入測試，維持 `SKIP`，不把計畫或靜態檢查寫成正式交易通過。

## 限制

- overview 與 section 查詢使用明確安全上限；若資料量超過上限，需另行設計伺服器端 aggregate／pagination，不可將本輪 partial response 當成無限資料集。
- image cache 以 deterministic product path 作為 edge key，並由目前所有 Worker 商品變更入口（`updateProduct`、`uploadProductImage`）purge；瀏覽器端仍以版本 query 避免更新後顯示舊圖。真正的 purge race、瀏覽器 immutable cache 與 unpublish stale-cache 行為仍需在隔離 staging 以受控寫入驗證，本輪未執行。
- 既有 working-tree dirty diff（含其他前端、付款、分類與 migration 相關檔案）保留，未 reset、checkout、部署或修改 migrations／wrangler／通知文案。
