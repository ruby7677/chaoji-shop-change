# Supabase 優化回歸／流量驗收計畫

> 本文件是唯讀驗收規劃，不代表已執行或已部署。驗收範圍是本機 Cloudflare Worker 加 `.dev.vars`；本次不得建立訂單、回報付款、調整庫存、發送通知、套用 migration 或部署。

## 1. 範圍與目前 baseline

以 `src/index.ts`、`public/app.js`、`supabase/migrations/` 及 `AGENTS.md` 的目前內容為準；文件與程式若不一致，以程式與已套用的遠端 migration 為準。Phase 1–3 的回歸重點如下：

| Phase 目標 | 必須保留的安全／功能不變量 | 流量驗收重點 |
| --- | --- | --- |
| Identity sync | 只從 Supabase Auth provider identity 取得 LINE ID；不可相信可編輯的 `user_metadata`；只可填補 `profiles.line_user_id` 的空值，不可覆蓋既有綁定；管理員仍須 `is_admin=true` 且 LINE ID 完全相符 | 重複會員 GET 不應重複寫入；非 LINE、過期 token、管理員綁定不一致都拒絕 |
| Admin section lazy loading | 未開啟後台或未選取分頁時，不載入管理資料；分頁資料只在首次進入時取回，重返同頁不應無限重複請求 | Network request、回應資料範圍、錯誤隔離與權限不可因 lazy loading 變寬 |
| Catalog／image cache | 公開目錄不洩漏 reservation、管理資料或 service key；圖片只可讀取已上架商品；圖片 URL 必須以 `image_updated_at` 版本化 | 量測 warm/cold GET、Cache-Control、ETag/版本 query、圖片更新後失效；不得以快取回傳私有或過期庫存 |
| 現貨／預購／混購 | 現貨匯款 24 小時、預購匯款 2 小時；現貨與預購分單；單筆 `pickup_plan` 只接受 `together` | 只用既有測試 fixture 或隔離資料庫做契約驗收；本次不 POST `/api/orders` |

現行程式的可觀察 baseline：

- `/api/health`、`/api/config`、`/api/catalog` 由共用 `json()` 加上 `Cache-Control: no-store`。
- `/api/catalog` 讀 `storefront_variants`；有圖片時只回傳 `/api/product-images/<product-id>?v=<image_updated_at>`，不回傳 reservation 明細。
- `/api/product-images/<uuid>` 先確認商品仍 `is_published=true`，再用 service role 讀私有 Storage，圖片回應目前是 `public, max-age=31536000, immutable`。
- 目前 `openAdmin()` 會呼叫一次 `/api/admin/dashboard`，而 `switchAdminTab()` 只切換 DOM；這是 lazy loading 的「優化前」基準，不可在驗收紀錄中誤稱為已分段載入。若 Phase 1–3 已加入分段 loader，依實際 request path/query 驗收，不預先捏造 endpoint 名稱。

## 2. 安全前提與不得做的操作

### 2.1 本機 Worker

在 `潮吉好頑/app/` 操作；`.dev.vars` 只存在本機，不複製回文件或 Git。測試環境應是隔離的 Supabase project／資料庫與無真實收件人的 fixture。若只能使用正式 project，僅允許本文件的 GET、靜態檢查與 metrics 讀取，跳過會觸發寫入的 identity first-bind 驗收。

`.dev.vars` 必須由安全來源填入，且本機回歸至少使用：

```dotenv
LINE_AUTH_ENABLED=true
LINE_NOTIFY_ENABLED=false
TELEGRAM_NOTIFY_ENABLED=false
# 不放真實通知 token；SUPABASE_SERVICE_ROLE_KEY 只供 Worker 讀取，不可輸出
```

不要把 token、JWT、LINE user ID、chat ID、會員姓名／電話、完整 `.dev.vars` 或 service-role header 貼到終端機紀錄、瀏覽器 Network 匯出或本文件。登入 token 用環境變數或秘密管理器注入，例如 `$memberToken`、`$adminToken`，不要寫入命令列歷史。

啟動前先確認目前差異，不能用 `git add .` 或覆蓋其他工作：

```powershell
git status --short -- '潮吉好頑/app'
npm ci
npm run dev -- --local --port 8787
```

`npm ci` 只在依賴需要重建時執行；不執行 `npm run deploy`、`wrangler deploy` 或 `wrangler dev --remote`。Worker 啟動後，另開終端機設定：

```powershell
$base = 'http://127.0.0.1:8787'
```

### 2.2 明確禁止

下列操作不屬於本次唯讀驗收，即使使用測試 token 也不要執行：

- `POST /api/orders`、`POST /api/orders/<id>/payment`。
- `POST /api/admin/telegram-test`、`POST /api/admin/line-test`、生日券 issue、任何通知或 scheduled handler。
- 訂單 transition／fulfillment、商品／規格／分類／收款帳戶新增或 PATCH、庫存調整、點數調整、優惠券儲存。
- `PUT /api/cart`、profile PATCH、圖片 upload/delete、Storage upsert、任何 RPC 會 INSERT／UPDATE／DELETE 的呼叫。
- 執行 `supabase db push`、`apply_migration`、SQL migration、`pg_stat_statements_reset()`（除非另有隔離 staging 與明確書面授權；見第 7 節）。
- 以高併發壓測取代低速驗收；不要為了製造 metrics 而重複點擊結帳或通知按鈕。

回歸紀錄應把「SKIP（會產生寫入／外部副作用）」視為合格的安全結果，不要為了湊到 200／201 而改用正式資料。

## 3. 唯讀 smoke checks

### 3.1 Health／config

只讀狀態碼與非敏感欄位，不輸出完整 JSON：

```powershell
$health = Invoke-RestMethod "$base/api/health"
[pscustomobject]@{ ok = $health.ok; database = $health.database; store = $health.store }

$config = Invoke-RestMethod "$base/api/config"
[pscustomobject]@{
  authEnabled = $config.authEnabled
  lineProvider = $config.lineProvider
  adminIdentityMode = $config.adminIdentityMode
  hasSupabaseUrl = [bool]$config.supabaseUrl
  hasAnonKey = [bool]$config.supabaseAnonKey
}
```

預期：`ok=true`、`database=true`、`authEnabled=true`、`adminIdentityMode=line_user_id+is_admin`；不得在輸出中出現 service-role key、通知 token 或完整 access token。若 `/api/health` 回 200 但 `database=false`，停止權限／訂單驗收，只保留靜態檢查。

### 3.2 Catalog

```powershell
$catalogResponse = Invoke-WebRequest "$base/api/catalog"
$catalog = $catalogResponse.Content | ConvertFrom-Json
[pscustomobject]@{
  status = $catalogResponse.StatusCode
  cacheControl = $catalogResponse.Headers['Cache-Control']
  count = @($catalog.products).Count
  allExpectedTypes = @($catalog.products | Where-Object { $_.type -notin @('現貨','預購') }).Count -eq 0
  hasReservationField = @($catalog.products | Where-Object { $_.PSObject.Properties.Name -match 'reservation' }).Count -gt 0
  hasServiceRoleText = $catalogResponse.Content -match 'service_role|SUPABASE_SERVICE_ROLE_KEY'
}
$catalog.products | Select-Object id, product_id, name, type, stock, image_url | Format-Table
```

預期：200；`products` 是陣列；`stock` 不小於 0；只出現已上架規格；`hasReservationField=false`、`hasServiceRoleText=false`。目前 baseline 的 `Cache-Control` 應為 `no-store`；若優化後改為可快取，必須另記錄 TTL、cache key、失效策略與庫存／上架狀態驗證，不能只因看到 HIT 就判定通過。

## 4. Identity sync 與權限矩陣

準備四種隔離 fixture token（不要把 token 值寫入紀錄）：

| 代號 | Supabase fixture | 預期用途 |
| --- | --- | --- |
| `M` | LINE 會員，`profiles.line_user_id` 已與 provider identity 相同，`is_admin=false` | 會員允許案例 |
| `A` | LINE 管理員，`is_admin=true` 且 `profiles.line_user_id` 與 provider identity 相同 | 管理員允許案例 |
| `X` | `is_admin=true`，但 profile LINE ID 與目前 provider identity 不同，或 identity 缺少可驗證 LINE ID | 管理員拒絕案例 |
| `E` | 非 LINE／Email identity，或過期／偽造 token | provider allowlist／過期 token 拒絕案例 |

### 4.1 Worker endpoint matrix

用同一個 GET 矩陣逐列記錄 `status`、非敏感 error code、response time；不要記錄整個 body。

| Request | 無 token | `E` | `M` | `A` | `X` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/cart` | 401 | 403 | 200（只含自己的 cart） | 200（只含自己的 cart） | 403 |
| `GET /api/orders` | 401 | 403 | 200（只含自己的 orders） | 200（只含自己的 orders） | 403 |
| `GET /api/member/points` | 401 | 403 | 200（只含自己的 ledger／coupon） | 200（只含自己的 ledger／coupon） | 403 |
| `GET /api/member/line-friendship` | 401 | 403 | 200 或受 LINE 驗證結果限制 | 200 或受 LINE 驗證結果限制 | 403 |
| `GET /api/bank-accounts` | 401 | 403 | 200（只回 active 結帳帳戶） | 200 | 403 |
| `GET /api/admin/dashboard` | 401 | 403 | 403「僅限管理員」 | 200 | 403 且 code=`ADMIN_LINE_ID_MISMATCH` |

補充檢查：

1. `M` 的 `/api/orders` 不接受任意 member ID 參數，也不應回傳其他會員訂單；使用兩個 fixture 的 GET 結果做集合比對即可，不要建立新訂單。
2. `A` 也只能透過受保護的 admin GET 讀取管理資料；`M` 不可因知道 URL 或手動顯示隱藏按鈕而取得 dashboard。
3. `E` 即使 `user_metadata` 自行帶入看似合法的 `line_user_id`，仍應被 `LINE_AUTH_ENABLED=true` 的 provider identity 檢查拒絕；不可因此觸發 profile 綁定。
4. 對不存在或格式不合法的 UUID 只做 GET（例如圖片），預期 404；不要把不存在的 ID 帶入任何寫入 endpoint。

### 4.2 Identity sync 的唯讀界線

`requireUser()` 在會員／管理 GET 前會呼叫 identity sync；sync 只在 `line_user_id is null` 時 PATCH。這代表「第一次綁定」本質上是受控寫入，不能在正式 project 以唯讀驗收假裝完成。

本次允許的 read-only 驗證：

- 對 `M`／`A` 先以會員自己的 Supabase GET（或已授權的 read-only fixture 查詢）確認 `line_user_id` 已存在且正確，再呼叫一次 `/api/cart` 或 `/api/admin/dashboard`。
- 再呼叫同一 GET，確認 `line_user_id`、`is_admin` 與資料列數未變；以 `pg_stat_statements` 或本機 mock／HTTP trace 確認沒有重複的 `UPDATE profiles ... line_user_id`。
- 用 `X`、`E` 重複上述 GET，確認被拒絕且既有 profile identity 欄位未變。

只有在一次性、可回復的隔離 staging fixture，並取得額外授權後，才可測試 `line_user_id=null` 的 first-bind：預期首次受保護 GET 只填入 provider identity，第二次不再寫入，且不能改變 `is_admin`。此案例不在本次實跑範圍，紀錄為 `SKIP: controlled write required`。

## 5. Admin section lazy loading

### 5.1 Browser／Network 驗收

使用已登入的 `A`，開啟瀏覽器 DevTools Network，勾選 Preserve log、Disable cache 僅用於可重現的 cold trace；不要把 Authorization header 匯出。每個 scenario 只做低速單次操作：

1. 清除 Network 後開啟首頁：只應看到 `/api/config`、`/api/catalog` 及必要的會員 GET；未點擊後台前不得出現 admin endpoint。
2. 開啟後台並記錄 baseline：目前版本預期出現一次 `/api/admin/dashboard`，而且回應包含 products、orders、members、points、coupons、categories 等全量欄位。這一列是優化前對照，不是 lazy loading 通過條件。
3. 若 Phase 1–3 版本已拆分 loader：開啟後台時只取 overview 所需欄位；逐一點擊 Products、Orders、Members、Inventory、Discounts 等分頁，每一分頁首次進入才產生對應 request。實際 path／query 以 Network 為準；不得假設一定叫 `/api/admin/<section>`。
4. 同一分頁第二次進入：應使用明確的 session cache 或只發出設計上必要的 revalidation；不可每次 tab click 無限重複下載全量 dashboard。按重新整理才可視為新 session。
5. 尚未點擊的分頁：其私有資料（會員、訂單、點數、優惠券、庫存異動）不可先出現在任何 response、DOM 或 prefetch request。
6. 以 `M` 開啟同一 URL：按鈕可隱藏是 UX，不是權限；手動送 `GET /api/admin/dashboard` 仍須 403。對 `X` 則須 403／`ADMIN_LINE_ID_MISMATCH`。
7. 暫時阻斷一個 section 的 GET（只在本機 mock／隔離環境）：該 section 顯示錯誤，其他已載入分頁仍可使用；不得退回顯示上一個會員／訂單的資料。

可用瀏覽器 console 做非敏感計數（不要輸出 URL query 中的 token）：

```js
performance.getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => name.includes('/api/'))
  .map((name) => new URL(name, location.origin).pathname)
```

### 5.2 Lazy loading 與資料權限交叉驗收

- 未登入、`E`、`M` 在首頁與所有分頁都不得因 preload 取得 admin data。
- `A` 的 dashboard response 不得把 `telegram_notification_logs`、service-role key 或不必要的 profile identity 欄位送到瀏覽器；管理員通知紀錄仍是 service-role-only。
- admin GET 的 request count 下降不算通過的唯一條件；每個分頁的資料集合、排序、統計數字、錯誤狀態要與 baseline 一致。
- 圖片在 admin Products 分頁仍須 `loading="lazy"`；只滾動到可視範圍才載入圖片，且 URL 仍走 `/api/product-images/<uuid>?v=...`。

## 6. Catalog／image cache 回歸

### 6.1 公開目錄

執行 1 次 cold GET、短暫間隔後 1 次 warm GET，再以固定低流量重複 5–10 次；不要用壓測工具。每次只記錄 status、response length、latency、Cache-Control、ETag／Age（若有）與產品筆數。

驗收條件：

- 所有 GET 都是 200；回應 JSON 結構與商品種類不變，`stock` 不可為負。
- 不同會員／管理員／匿名的公開 catalog 不得因 Authorization 而洩漏私有欄位；cache key 不得把私人 response 共享給其他角色。
- 目錄沒有 `inventory_reservations` rows、會員、訂單、管理備註、通知 log 或 service key。
- 如果 Phase 版本把 catalog 從 `no-store` 改成 `public`／`s-maxage`，必須用「上架狀態／可售庫存／分類」的既有 fixture 做失效驗證；本次不改商品或庫存，因此只能驗證 header、key 與已知版本策略，不能宣稱完成 stale-data 測試。
- 如果仍維持 `no-store`，記錄這是安全的 baseline，並以 `pg_stat_statements` 比較 query 次數／時間，不把未命中 HTTP cache 當成 regression。

### 6.2 圖片

從 `/api/catalog` 找一個已有 `image_url` 的已上架商品；若 fixture 沒有圖片，記錄 `SKIP: no image fixture`，不要為了測試上傳圖片。

```powershell
$imageUrl = [uri]::new([uri]$base, [string]$catalog.products[0].image_url).AbsoluteUri
$imageResponse = Invoke-WebRequest $imageUrl
[pscustomobject]@{
  status = $imageResponse.StatusCode
  contentType = $imageResponse.Headers['Content-Type']
  cacheControl = $imageResponse.Headers['Cache-Control']
  bytes = $imageResponse.RawContentLength
}
```

預期：已上架且有圖為 200、Content-Type 僅為 `image/jpeg`／`image/png`／`image/webp`，目前 baseline 的 Cache-Control 為 `public, max-age=31536000, immutable`。以同一版本 URL 做第二次 GET，確認 body／Content-Type 一致；以不存在 UUID、已知未上架 UUID（只能從既有 read-only admin fixture 取得）GET，預期 404，不得因猜到 Storage path 而讀到圖。

不可用 PATCH、upload 或刪除舊圖來驗證 invalidation。只可靜態確認 URL 含 `image_updated_at` 版本；真正的「新圖後舊快取失效」留給隔離 staging 的受控寫入測試。

## 7. 現貨／預購／混購契約矩陣（本次不執行 POST）

以下是應在另一次隔離資料庫交易測試中驗收的向量；本次只核對 Worker validation、RPC／migration 內容與 UI 分組，不呼叫 `/api/orders`。若驗收表需要填結果，統一記 `NOT RUN — side effect prohibited`。

| 購物車類型 | 配送／付款組合 | 預期 | 關鍵理由／錯誤碼 |
| --- | --- | --- | --- |
| 全現貨 | `seller_delivery` + 外部取貨付款（無本站收款帳戶） | 允許 | 先建立本站待確認訂單，再由外部賣貨便付款；不得把外部付款當本站現金 |
| 全現貨 | `seller_delivery` + 本站匯款 | 拒絕 | `SELLER_BANK_PREORDER_ONLY` |
| 全預購 | 到店／宅配 + 本站匯款 | 允許 | 訂金 50%；預購付款期限 2 小時 |
| 全預購 | `seller_delivery` + 本站匯款付訂 | 允許 | 到貨後由客服開立賣貨便，運費由 7-11 收取 |
| 全預購 | `seller_delivery` + 外部取貨付款 | 拒絕 | `STORE_PAYMENT_PREORDER_NOT_ALLOWED` |
| 全現貨 | 到店／宅配 + `store_payment` | 拒絕 | `STORE_PAYMENT_BANK_TRANSFER_ONLY`；本站到店／宅配只收匯款 |
| 現貨＋預購 | 任一配送／付款 | 拒絕單筆混購 | `MIXED_ORDER_NOT_ALLOWED`；前台應分成兩組後分別結帳 |
| 任一單一類型 | `pickup_plan=split` | 拒絕 | `INVALID_PICKUP_PLAN`；目前單筆固定 `together` |
| 現貨匯款 | 任一允許配送 | 期限 24 小時 | migration／RPC deadline |
| 預購匯款 | 任一允許配送 | 期限 2 小時 | migration／RPC deadline |

只做靜態／唯讀的補充驗證：

- 檢查 `public.product_kind`、`storefront_variants.type`、`deposit_rate=0.5` 的 migration／function definition 是否一致。
- 檢查前台混購 cart 會顯示兩組 checkout action，且每次 request 的 item set 僅含單一 kind；這是 DOM／source review，不是送出訂單。
- 不用 `curl -X POST`、瀏覽器建立訂單、付款回報或管理員狀態 transition 來「驗證」上述案例。

## 8. 會員購物車／管理員資料的唯讀驗收

### 8.1 Member cart

- `M` 的 `GET /api/cart` 可回自己的 `variant_id,quantity`，數量符合 1–100、最多 50 筆；空車也應回 200 與空陣列。
- 以兩個 fixture member 的 JWT 各自 GET；結果不可交叉。若可直接對 Supabase 做 read-only RLS query，`member_cart_items?member_id=<other>` 對 `M` 應是空集合／不洩漏列。
- 不執行 `PUT /api/cart`；跨裝置 merge、刪除已結帳品項與 RPC 原子替換留給隔離 staging 的受控寫入測試。
- `M`、`A` 的 GET 重複執行不應造成 cart rows 增加或變更；metrics 應看不到不必要的 delete／insert。

### 8.2 Admin data

- `A` 的 admin GET 可以讀需要的 products／categories／orders／members／points summary；只記錄 keys、counts、status，不把姓名、電話、地址、帳號或訂單號寫入報告。
- `M`、`X`、`E` 與無 token 不可讀 dashboard；不能只依賴前端 `hidden` class。
- `telegram_notification_logs`、庫存異動與其他 service-role-only 表不可由 anon／authenticated 直接 Data API 讀取；若做 direct REST GET，只記 status／row count，絕不使用 service-role key 在瀏覽器執行。
- 任何會改動 `profiles.line_user_id`、`profiles.is_admin`、商品、庫存、訂單、點數或通知 log 的 negative write 都不是本次測試，應標記 SKIP。

## 9. pg_stat_statements 前後比較

### 9.1 預設：timestamp／snapshot（唯讀）策略

不要 reset 共用 project 的全域統計。開始前只讀取 clock、view 是否存在與必要欄位，並把輸出存到本機不含 token 的 audit note：

```sql
select clock_timestamp() as audit_started_at;
select to_regclass('public.pg_stat_statements') as public_view,
       to_regclass('extensions.pg_stat_statements') as extensions_view;
select * from pg_stat_statements_info;
```

依實際存在的 view 讀取相同 snapshot（Supabase 可能把 extension 放在 `extensions` schema）：

```sql
select queryid, calls, total_exec_time, rows,
       shared_blks_hit, shared_blks_read, stats_since, query
from extensions.pg_stat_statements
where query ilike '%storefront_variants%'
   or query ilike '%product-images%'
   or query ilike '%member_cart_items%'
   or query ilike '%profiles%'
order by total_exec_time desc;
```

若 view 在 `public`，替換 schema；若版本沒有 `stats_since`，刪除該欄位，以 `queryid` 對 before／after snapshot 相減。完成固定低流量 GET 後，再執行同一份 SELECT，計算每個 `queryid` 的 `Δcalls`、`Δtotal_exec_time`、`Δrows`、hit/read；同時記錄 `pg_stat_statements_info.stats_reset` 是否在期間改變。不要把 SQL Editor 自己的 introspection query 算入 Worker traffic。

建議比較欄位：

- catalog：`storefront_variants` 的 calls／平均 execution time／shared hit ratio。
- image：published product lookup 與 Storage object request 的 calls／錯誤數。
- identity：重複 GET 後 `profiles` identity UPDATE 應為 0（已綁定 fixture）；first-bind 僅在隔離 staging 記 1 次。
- admin lazy：overview／各 section 的 query calls 應只在對應 tab 首次進入增加，不應每次 tab 切換都增加全量 dashboard queries。

### 9.2 可選 reset 策略（本次不得執行）

`select pg_stat_statements_reset();` 會清掉該資料庫／統計範圍的既有 query stats，對共用或正式 project 是破壞性觀測操作。本次不得執行。只有另有隔離 staging、資料庫 owner 明確授權、已保存 reset 前 snapshot，才可：

1. 保存 `pg_stat_statements` 與 `pg_stat_statements_info` before snapshot。
2. 在隔離 staging reset，記錄精確 UTC timestamp。
3. 只跑本文件允許的低流量 GET，不能混入訂單／通知／migration。
4. 讀 after snapshot，確認 calls、latency、rows 與錯誤查詢，再保留 reset 前後紀錄。

若無法確認 view schema、統計追蹤設定或 reset 權限，採用 9.1 的 timestamp／delta，不能重試 reset。

## 10. 程式、差異與本機 smoke checklist

這些檢查不會建立訂單或發送通知：

```powershell
node --check public/app.js
npm run typecheck
git diff --check
git status --short -- '潮吉好頑/app'
```

預期：`node --check` 與 `npm run typecheck` exit 0；`git diff --check` 無 whitespace error；status 顯示本文件新增與原先已存在的 dirty files，不能有本次意外修改的 `src/`、`public/`、`supabase/migrations/`、`wrangler.jsonc` 或 `.dev.vars`。文件任務不執行 `npm run deploy`；`wrangler deploy --dry-run` 也不是本次必要步驟，除非另有程式／部署設定變更授權。

Worker 已啟動且只使用隔離 `.dev.vars` 時，再執行第 3 節的 `/api/health` 與 `/api/catalog`；若沒有安全 fixture 或本機 Worker 未啟動，記錄 `SKIP`，不要改用正式 API。最終驗收紀錄至少包含：

- commit／working-tree baseline、Worker local port、測試時間 UTC；不含 secret。
- health／catalog status、非敏感 header、products count、image fixture 是否存在。
- `M`／`A`／`X`／`E` 權限矩陣結果、lazy Network trace 摘要、cache headers。
- pg_stat snapshot 方法（timestamp 或隔離 reset）；若未執行寫入案例，明確列 `NOT RUN — side effect prohibited`。
- 未完成項目與原因；不得把計畫、靜態檢查或 baseline 觀察寫成「已部署／已通過真實交易」。
