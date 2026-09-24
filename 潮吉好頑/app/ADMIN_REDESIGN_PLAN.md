# 後台 UI/UX 遷移計劃書：正式後台 → 新設計（redesign-preview）

> 建立：2026-09-24。目標設計：`redesign-preview/admin.html`。
> 範圍：**只改前端外觀與操作動線，不改 Worker、SQL、權限與交易邏輯**。
> 部署：2026-09-24 經店主授權上線，Version ID `ded8db43-575b-4b8a-abcd-d7b19af626ad`（前一版 `7f55e55e-e876-42a9-a27c-fabaf3856b3a`）。

## 1. 現況盤點（已核對程式碼）

| 項目 | 正式後台現況 | 位置 |
|------|------------|------|
| 容器 | `<dialog id="admin-dialog">`，最寬 1180px 的彈窗，四周露出前台 | `index.html:112`、`styles.css:612` |
| 導覽 | 9 個平鋪按鈕，無分組、無圖示、無待辦數字；手機變成橫向捲動條 | `.admin-nav` |
| 頁首 | 無頂欄；標題在各面板內，關閉鈕 sticky | `.admin-content>.dialog-close` |
| 資料流 | `switchAdminTab` → `loadAdminSection` → `/api/admin/dashboard?section=…` → `renderAdminSection` 寫入固定 id 容器 | `app.js:2196–2330` |
| 營運概況 | 5 個數字按鈕（可點擊篩選）＋重新整理＋Telegram 測試；**沒有待辦清單、最新訂單、低庫存清單** | `renderAdminSection('overview')` |
| 訂單 | 搜尋框＋狀態下拉；每筆訂單都是**完整展開的大卡片**（明細、金額 9 欄、動作表單、宅配尾款表單、退貨、歷程），一次 100 筆 | `renderAdminOrders()` `app.js:2649` |
| 商品 | 大卡片＋`<details>` 內嵌編輯表單、規格表單（已含原價、不可積點、多圖、詳細介紹） | `renderAdminProducts()` `app.js:3041` |
| 其他分頁 | 會員、收款帳戶、庫存、優惠券、稽核、通知皆可用，表單多為 `<details>` 摺疊 | — |
| 視覺 | 已有一層中性灰 `--admin-*` token（Codex 版），與品牌黃黑不一致 | `styles.css:607` |

## 2. 與新設計的落差（依影響排序）

| # | 新設計有、正式版缺少 | 影響 | 優先 |
|---|--------------------|------|------|
| G1 | 全螢幕工作區（左側欄＋頂欄＋內容），不再是彈窗 | 後台可用面積小、捲動雙層 | P0 |
| G2 | 側欄**分組**（營運／商品／會員行銷／系統）＋圖示＋**待辦數字徽章** | 找功能慢、看不到哪裡要處理 | P0 |
| G3 | 頂欄：頁面標題、**全域搜尋**（訂單編號／姓名／手機／末五碼，按 `/` 聚焦）、重新整理、資料更新時間 | 查單要先切頁再找 | P0 |
| G4 | 概況頁**今日待辦**（待確認款項、賣貨便待核對、退款處理）＋**低庫存清單**＋**最新訂單** | 店長每天第一眼看不到要做什麼 | P0 |
| G5 | 訂單**狀態分頁（含數量）**取代下拉選單 | 切換狀態要點兩下、看不到各狀態數量 | P1 |
| G6 | 訂單**精簡列＋展開詳情**（先看摘要，需要處理時才展開動作表單） | 100 張大卡片難以掃描 | P1 |
| G7 | 品牌化視覺 token（墨黑側欄、太陽黃焦點、語意色狀態） | 前後台風格不一 | P1 |
| G8 | 手機：側欄改抽屜、表格轉卡片、觸控目標 ≥ 40px | 手機管理困難 | P1 |
| G9 | 商品列表精簡列、每列「優惠價」快速設定 | 改價要展開多層 | P2（正式版表單已可設原價，功能不缺） |
| G10 | 新增類表單改側滑面板（sheet） | 表單散落在摺疊區 | P2 |

**不需遷移（正式版已具備）**：原價／限時優惠、不可積點、多圖與詳細介紹、分類管理、庫存異動防呆、退貨確認、宅配尾款表單、通知重送、稽核篩選、分頁。

## 3. 遷移策略

比較兩種方案：

| 方案 | 做法 | 優點 | 缺點 |
|------|------|------|------|
| A. 重寫 | 用預覽的模組重寫全部後台渲染 | 結構最乾淨 | 訂單動作規則極複雜（依取貨方式／預購／宅配尾款產生不同動作），重寫高機率引入交易 bug；工作量數天 |
| **B. 外殼重構＋漸進增強（採用）** | 保留 `app.js` 既有資料流、id、表單與送出邏輯；新增獨立模組負責外殼、導覽、頂欄、概況、訂單分頁與精簡化 | 交易邏輯零改動、可逐階段驗收與回退 | 部分舊 DOM 結構需用 CSS 重新排版 |

實作原則（依 `AGENTS.md`）：

- 新功能放新檔：`public/admin-shell.js`、`public/admin-overview.js`、`public/admin-orders-ui.js`、`public/admin-shell.css`；`app.js` 只加 import 與一次 `initAdminShell({...})` 接線（依賴注入，不暴露全域）。
- CSP 無 `unsafe-inline`：動態 HTML 不寫 `style=""`，改用 class。
- 保留所有既有 id／`data-admin-*` selector，舊邏輯不需改動。
- 每檔 < 500 行。

## 4. 分階段實作

### Stage 0：本機測試台
**Goal**：不需 LINE 登入即可在本機載入真實 `app.js` 後台。
**做法**：`public/__admin-harness.html`（暫存，完成後刪除）＋fetch stub，模擬 `/api/config`、Supabase 使用者／profile（`is_admin=true`）與 `/api/admin/*` 各 section 回應；加上與 Worker 相同的 CSP meta 以抓出 inline style 違規。
**Success Criteria**：測試台能開啟後台並切換 9 個分頁、無 console 錯誤。
**Status**：Complete（2026-09-24）— 測試台放在 session scratchpad（不進 repo）：`serve.py` 即時從 `public/index.html` 產生 `/__harness.html`、注入 Worker 同款 CSP 與 fetch stub。9 分頁載入皆成功。

### Stage 1：全螢幕外殼與品牌 token（G1、G7）
**Goal**：後台改為全螢幕工作區，側欄＋內容；品牌色 token。
**Success Criteria**：桌機 ≥1100px 固定側欄；所有分頁內容可捲動；關閉可回前台；Esc 仍可關閉。
**Tests**：9 分頁切換、1440／1024／768／375 寬度截圖檢查。
**Status**：Complete（2026-09-24）— `public/admin-shell.css`、`public/admin-shell.js`；以 `#admin-dialog.admin-app` 前綴覆寫舊規則，未刪改 `styles.css`。

### Stage 2：分組導覽、徽章、頂欄、手機抽屜（G2、G3、G8）
**Goal**：側欄分 4 組＋圖示＋待辦數字；頂欄標題／全域搜尋／重新整理／更新時間；手機漢堡選單。
**Success Criteria**：徽章數字 = `stats.pendingReview + sellerPending`（訂單）、`lowStock`（庫存）；全域搜尋 Enter 後切到訂單並帶入關鍵字重新查詢；`/` 聚焦搜尋。
**Status**：Complete（2026-09-24）— 分組導覽＋圖示＋徽章（訂單 2／庫存 3 驗證正確）、頂欄全域搜尋（Enter 切訂單並查詢、`/` 聚焦）、手機抽屜（375px 無橫向溢出）；修正舊手機規則 `align-items:center` 造成的偏移。

### Stage 3：概況頁儀表板（G4）
**Goal**：今日待辦、低庫存清單、最新訂單。
**做法**：概況載入時另以 `adminFetch` 讀取 `section=orders&status=all&page=0` 與 `section=products`（只讀，不寫入 `adminData`，避免干擾訂單頁篩選狀態）。
**Success Criteria**：待辦依緊急程度排序、點「處理」跳到訂單頁並篩選該訂單；讀取失敗時顯示錯誤文字而非空白。
**Status**：Complete（2026-09-24）— `public/admin-overview.js`＋`public/admin-pages.css`；待辦（確認款項／退款／賣貨便／宅配尾款）、低庫存、最新訂單；「處理」跳到該筆訂單、「補貨」預選規格並聚焦數量；讀取失敗顯示錯誤文字。

### Stage 4：訂單狀態分頁＋精簡列（G5、G6）
**Goal**：狀態分頁（含數量）與原下拉同步；訂單卡預設收合成摘要列，點擊展開完整內容（動作表單不變）。
**Success Criteria**：分頁切換結果與原下拉一致；展開後原表單可正常送出；需處理的訂單（待確認款項、賣貨便待核對）預設展開或醒目標示。
**Status**：Complete（2026-09-24）— `public/admin-orders-ui.js`：狀態分頁（數字取自 stats）與原下拉雙向同步；卡片以 class 收合（不搬動 DOM），待確認款項／退款／賣貨便／可填尾款的訂單預設展開並以橘色左框標示；「全部展開／收合」。實測展開後送出轉換 → 呼叫 `/transition` → 重新載入 → 成功提示，重新渲染後仍自動套用。

### Stage 5：商品列表精簡（G9，選配）
**Goal**：商品卡改精簡列樣式、顯示限時優惠標籤；「優惠價」直接展開對應規格表單並聚焦原價欄。
**Status**：Complete（2026-09-24）— `public/admin-products-ui.js`：有優惠的商品卡紅色左框＋「限時優惠」標籤、規格列顯示「限時優惠 −x%」、每個規格「優惠價」捷徑（展開該規格表單並聚焦原價欄，仍由原表單儲存）、「只看限時優惠（本頁 n）」篩選。

### Stage 7：滑出面板、說明收合、其餘頁面統一樣式（G10 與第二輪待辦）
**Goal**：新增／設定類表單改為右側滑出面板；面板頂部長說明收合；會員、優惠券、帳戶、庫存、稽核、通知頁卡片與表單統一。
**做法**：`public/admin-sheets.js`＋`public/admin-forms.css`。沿用各頁 `<details class="admin-create">`（新增商品、分類管理、新增規格、點數規則、優惠券、生日券），只把內容包進面板容器，表單元素、id 與事件綁定不變。
**Status**：Complete（2026-09-24）— 面板開啟／遮罩／一次一個；Esc 只關面板不關後台；「編輯優惠券」自動開啟面板並帶入資料；送出成功（原程式重設表單）後 10 秒內自動關閉，失敗保留內容；說明文字真的超過兩行才顯示「展開說明」。實測：優惠券 PUT、建立商品 POST 皆正常並顯示成功提示；4 種寬度 × 9 頁 × 6 個面板無溢出。
### Stage 6：驗收
`node --check`（所有新 JS 與 app.js）、`git diff --check`、CSP 檢查（無 inline style）、四種寬度截圖、刪除測試台檔案。
**Status**：Complete（2026-09-24）— 新 JS 與 `app.js` 皆通過 `node --check`；新模組無 inline `style=`（測試台套用 Worker 同款 CSP，無違規）；1440／1024／768／375 × 9 分頁共 36 組無橫向溢出、無錯誤；`npx wrangler deploy --dry-run --minify` 打包成功（未部署）。測試台檔案只在 session scratchpad，未進 repo。

## 5. 風險與回退

- **後台 API 速率限制**：`API_ADMIN_RATE_LIMITER` 每位管理員 20 次／60 秒、所有後台請求都計入。新版開啟後台由 1 次增為 3 次（概況＋待辦所需的訂單、商品清單）。緩解：概況清單快取 3 分鐘、切回概況不重抓、只在按重新整理或送出表單後重抓；429 時顯示「操作太頻繁，請 1 分鐘後再試」。若店長實際使用仍覺得常觸頂，後續可（需另行授權改 Worker）新增單一 `section=dashboard-summary` 端點，或把上限調到 40。

- 所有新行為集中在新檔；回退只需移除 `app.js` 的 import 與 `index.html` 的 CSS link。
- 不改 API 與 SQL，交易結果不受影響；訂單送出仍走原 `submitAdminOrderTransition` 等函式。
- 未部署：正式站維持現況，需店主驗收後另行授權部署。

## 6. 本次成果與待辦

**新增檔案**：`public/admin-icons.js`、`public/admin-shell.js`、`public/admin-overview.js`、`public/admin-orders-ui.js`、`public/admin-products-ui.js`、`public/admin-sheets.js`、`public/admin-shell.css`、`public/admin-pages.css`、`public/admin-forms.css`。
**修改檔案**：`public/app.js`（+1 import、+1 `initAdminShell({...})` 接線，約 10 行）、`public/index.html`（+3 個 CSS link）。`styles.css`、Worker、SQL 均未修改。

**店主驗收**：2026-09-24 店主確認新版後台 OK，本計劃結案。收款帳戶與庫存調整表單刻意保留在頁面上（編輯帳戶會直接聚焦欄位、庫存調整是該頁主要動作）。

**上線紀錄**：2026-09-24 部署 Version ID `ded8db43-575b-4b8a-abcd-d7b19af626ad`，`wrangler deployments list` 確認 100% 流量。部署前以 Node fetch 比對正式站 16 個靜態檔與本機（扣除本次接線行後完全一致，`index.html` 差異僅為 Worker 動態注入的分享標籤），確認未夾帶他人未上線修改。部署後 smoke 16 項全過：health／config／catalog／首頁含 3 個新 CSS／CSP 無 unsafe-inline／未登入 `/api/admin/dashboard` 回 401／7 個新 JS 與 3 個新 CSS 皆 200 且含 marker；正式首頁以訪客身分載入無 console 錯誤、後台外殼已初始化。
**原上線步驟**：依 `AGENTS.md`「Cloudflare 部署穩定流程」：`node --check`、`npm run typecheck`、`git diff --check`、`npx wrangler deploy --dry-run --minify` → `npx wrangler deploy --minify` → smoke 檢查正式 `admin-shell.css`／`admin-shell.js` 可取得（200）與首頁無錯誤。回退：移除 `index.html` 兩個 CSS link 與 `app.js` 的 import／初始化即可。

## 7. 上線後修正（2026-09-24）
**Status**：Complete（部署 Version ID `4ac77490-da40-42a7-82a5-5da6f040a431`；前一版 `ded8db43-575b-4b8a-abcd-d7b19af626ad`）
- 店主回報：手機新增／編輯優惠券只出現淡灰色畫面，點一下又回到原畫面。原因：滑出面板（`position:fixed`）位於後台捲動容器內，iOS／LINE WebKit 會把 fixed 元素困在捲動容器圖層（被外層遮罩蓋住，或跟著捲動內容定位到畫面外），只剩遮罩可見。修正：面板開啟時移到 `#admin-dialog` 最外層、關閉時放回 `<details>`（`admin-sheets.js`）；控制項樣式同時涵蓋 `.admin-sheet-panel`（`admin-forms.css`）；捲動容器改回 `-webkit-overflow-scrolling:auto`（`admin-shell.css`）。
- 同時修正：在「新增商品」面板按「新增分類」時，分類面板會被立即關閉（一次一個面板的邏輯保留了錯的那個）。
- 驗證（本機測試台，375／1280）：捲到優惠券列表 1418px 深處按編輯，面板仍滿版顯示於螢幕、中央點擊命中面板；6 個面板開關、Esc、放回原位皆正常；儲存失敗時面板與內容保留、錯誤提示顯示於面板上方；成功後自動關閉。Chromium 無法重現 iOS 圖層行為，需店主以手機再確認一次。