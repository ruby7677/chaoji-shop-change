# 潮吉好頑 Cloudflare + Supabase 專案

此資料夾包含可部署到 Cloudflare Workers 的靜態前台與 Worker API 骨架，以及 Supabase 初始 schema。

## 本機啟動

1. 安裝 Node.js 22 以上。
2. 執行 `npm install`。
3. 複製 `.dev.vars.example` 為 `.dev.vars`；未填 Supabase 時，`/api/catalog` 會回傳兩筆示範商品。
4. 執行 `npm run dev`。

## Supabase 初始化順序

1. 建立 Supabase 專案並依檔名順序在 SQL Editor 執行 `supabase/migrations/` 內的 migration；目前最新為 `202609110008_purchase_limit_management.sql`。
2. 在 Cloudflare Workers 設定 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 與 `SUPABASE_SERVICE_ROLE_KEY` 為 secrets。
3. 為 LINE Login 建立 callback 路徑，例如 `https://你的網域/auth/line/callback`；密鑰只放入 Cloudflare secrets。
4. 先以管理端建立商品、主圖、規格、庫存與賣貨便連結後再開啟商品上架。商品主圖支援 JPG、PNG、WebP，每張上限 5MB。
5. LINE 官方帳號通知需另外設定 `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`、`LINE_ADMIN_USER_IDS`（逗號分隔）與 `LINE_NOTIFY_ENABLED=true`；Worker 會在訂單建立、付款回報、管理員切換狀態、低庫存與生日券發送時通知。會員結帳前會優先使用 LINE Login provider token 檢查好友狀態，無 provider token 時改用官方帳號可推播性檢查；未加入好友時可瀏覽網站，但必須先加入官方 LINE 才能建立訂單。管理員可在後台「營運概況」按「測試 LINE 通知」驗證設定。

LINE 自訂登入提供者與 callback 設定請參考 `SUPABASE_SETUP.md`。

如果已經執行過舊版 `202609080001_initial_schema.sql`，不可重跑；請依序執行後續 migration，再以 `supabase/verify_schema.sql` 唯讀驗證。

## 已完成與待續

- 已完成：Cloudflare 靜態資產與 API、Supabase Auth + LINE OAuth、首次登入會員資料、商品目錄與主圖、交易保護的訂單建立、匯款末五碼回報、會員訂單查詢、24 小時庫存保留與自動釋放、管理端商品／規格／收款帳戶／庫存／訂單／會員／點數、優惠券、生日券自動發送與結帳點數折抵。
- 已完成：LINE 官方帳號訂單、低庫存與生日券通知（含每小時 Cloudflare Cron 與管理端立即發送）。
- 已完成：賣貨便／宅配到貨後由管理員設定實際運費、記錄尾款匯款末五碼；未確認尾款與運費前不可完成寄送訂單。
- 已完成：管理後台會員頁可展開查看會員消費訂單與點數帳本。
- 已完成：收緊匿名角色對內部 Supabase 函式的直接執行權，保留登入會員與 Worker 所需權限。
- 已完成：前台商品詳情視窗、商品說明、規格選擇、庫存／預購資訊、限購提示與加入購物車。
- 已完成：後台新增／編輯商品可設定每位會員限購數量，留空代表不限購。
