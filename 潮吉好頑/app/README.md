# 潮吉好頑 Cloudflare + Supabase 專案

此資料夾包含可部署到 Cloudflare Workers 的靜態前台與 Worker API 骨架，以及 Supabase 初始 schema。

## 本機啟動

1. 安裝 Node.js 22 以上。
2. 執行 `npm install`。
3. 複製 `.dev.vars.example` 為 `.dev.vars`；未填 Supabase 時，`/api/catalog` 會回傳兩筆示範商品。
4. 執行 `npm run dev`。

## Supabase 初始化順序

1. 建立 Supabase 專案並依檔名順序在 SQL Editor 執行 `supabase/migrations/` 內的 migration；本機原始碼最新為 `202609240001_product_gallery_showcase.sql`（2026-09-24 核對正式 DB 已全部套用），production 套用前請先核對 migration history，已有 migration 時不要重跑。
2. 在 Cloudflare Workers 設定 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 與 `SUPABASE_SERVICE_ROLE_KEY` 為 secrets。
3. 為 LINE Login 建立 callback 路徑，例如 `https://你的網域/auth/line/callback`；密鑰只放入 Cloudflare secrets。
4. 先以管理端建立商品、照片、規格、庫存與賣貨便連結後再開啟商品上架。每件商品最多 10 張照片（第 1 張為主圖），可選 JPG、PNG、WebP，瀏覽器會優先保留比例、縮放並轉成 WebP；若瀏覽器不支援轉換則保留原始格式，Worker 仍會驗證格式且每張上限 5MB。
5. 會員 LINE 通知需設定 `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` 與 `LINE_NOTIFY_ENABLED=true`；管理員通知改由 Telegram，需設定 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ADMIN_CHAT_IDS`（逗號分隔）與 `TELEGRAM_NOTIFY_ENABLED=true`。訂單建立／狀態更新會以 LINE 通知會員、以 Telegram 通知管理員；會員回報匯款、低庫存與後台測試只通知 Telegram 管理員，生日券只通知 LINE 會員。會員結帳前仍使用 LINE Login provider token 檢查好友狀態。

LINE 自訂登入提供者與 callback 設定請參考 `SUPABASE_SETUP.md`。

如果已經執行過舊版 `202609080001_initial_schema.sql`，不可重跑；請依序執行後續 migration，再以 `supabase/verify_schema.sql` 唯讀驗證。

## 已完成與待續

- 已完成：Cloudflare 靜態資產與 API、Supabase Auth + LINE OAuth、首次登入會員資料、商品目錄與主圖、交易保護的訂單建立、匯款末五碼回報、會員訂單查詢、預購 2 小時／現貨 24 小時付款期限與自動釋放、管理端商品／規格／收款帳戶／庫存／訂單／會員／點數、優惠券、生日券自動發送與結帳點數折抵。
- 已完成：會員訂單與生日券使用 LINE；管理員訂單、匯款回報、低庫存與後台測試改用 Telegram（Cloudflare Cron：每 5 分鐘重試失敗通知、每小時另執行排程通知）。
- 已完成：現貨與預購混購會在購物車分組並分別建立訂單；現貨賣貨便先建本站待確認訂單再導向外部連結，預購賣貨便先在本站匯款付訂、到貨後由客服開立賣貨便。
- 已完成：會員登入後同步雲端購物車；訪客購物車會與會員購物車合併，跨裝置可繼續結帳。
- 已完成：LINE Login 使用同一分頁 redirect；OAuth 前以短期 `sessionStorage` 保存必要的首頁／購物車／結帳 UI 暫態，callback 完成 session、會員與購物車初始化後再恢復，逾時或格式錯誤會自動丟棄。
- 已完成：管理後台會員頁可展開查看會員消費訂單與點數帳本。
- 已完成：後台商品管理可選擇／變更商品分類，並可新增、改名、排序與停用分類；停用分類不會套用到新商品，也不會清空既有商品分類。
- 已完成：會員點數餘額由完整帳本計算，前台最近 100 筆僅作歷程顯示；通知採 service-role 原子 claim、lease、fencing token 與可重試狀態機。外部 LINE／Telegram API 仍屬 at-least-once，網路逾時後可能需要人工確認是否重複送達。
- 已完成：未扣庫存的取消只釋放 reservation；已扣庫存且尚未完成交付的取消會原子反轉原 sale movement。賣貨便已出貨狀態採保守退款流程；退款完成後由管理員逐項驗收退貨，分為可再售回補或報廢並保留不可變更紀錄。
- 已完成：管理員商品、規格、分類、收款帳戶、優惠券、生日券／點數設定與會員點數調整透過白名單 RPC 同步寫入不可更新／刪除的 `audit_logs`；訂單／會員後台搜尋與狀態篩選由資料庫執行並支援分頁。
- 已完成：商品、優惠券與庫存異動清單移除靜默固定頁數；商品搜尋、優惠券與庫存異動均由資料庫 RPC 分頁（後台商品的分類／類型／上架狀態篩選在已載入的頁面內進行），商品／規格／分類／會員 options 由獨立完整 payload 提供。
- 已完成：管理員通知紀錄可依頻道／狀態查看；failed 通知可由管理員確認後排入下一次 cron 重試，不會在按鈕操作時直接呼叫外部通知 API。
- 已完成：通知紀錄補充安全的收件人姓名／管理員 Telegram 與已知訂單編號；生日券、低庫存與測試等非訂單事件不猜測訂單。
- 已完成：收緊匿名角色對內部 Supabase 函式的直接執行權，保留登入會員與 Worker 所需權限。
- 已完成：前台商品頁（`/products/:id`，取代舊商品詳情視窗）：多圖、詳細介紹、規格選擇、庫存／預購資訊、限購提示、加入購物車、推薦商品與 LINE 分享預覽；首頁新品／熱款輪播。詳見 `PRODUCT_SHOWCASE_PLAN.md`。
- 已完成：後台新增／編輯商品可設定每位會員限購數量，留空代表不限購。
- 已完成：商品可設定「不可累積會員點數」；建立訂單時由資料庫快照積點資格，完成訂單只計算可積點商品金額，既有點數折抵與優惠券規則維持不變。
- 已完成：首頁商品卡顯示現貨／預購保留徽章；預購顯示「訂金50%」，不可累積點數的商品顯示「不可積點」。
- 已完成：規格可設定原價與售價；原價高於售價時，前台顯示刪除線原價、紅色售價與「限時優惠」徽章，後台可新增／編輯原價。
- 已完成：後台改為全螢幕工作區（分組導覽、待辦徽章、全域搜尋、概況待辦、訂單狀態分頁、滑出面板），商品與規格頁為一列一個規格的表格（手機為卡片），含上架開關（先確認）與優惠價／編輯面板。詳見 `ADMIN_REDESIGN_PLAN.md`。
