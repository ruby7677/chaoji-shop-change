# 後台 UI/UX 遷移計劃書：正式後台 → 新設計（redesign-preview）

> 建立：2026-09-24。目標設計：`redesign-preview/admin.html`。
> 範圍：**只改前端外觀與操作動線，不改 Worker、SQL、權限與交易邏輯**。
> 部署：2026-09-24 經店主授權上線，Version ID `ded8db43-575b-4b8a-abcd-d7b19af626ad`（前一版 `7f55e55e-e876-42a9-a27c-fabaf3856b3a`）。
> 現況（2026-09-24）：Stage 0–8 與上線後修正皆完成並經店主確認；第 9 節（畫面內確認）已部署。最新 Version ID `f12d9aeb-0969-400a-834d-969974b565d3`（第 10 節）。

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
**Status**：Complete（2026-09-24）— `public/admin-products-ui.js`：有優惠的商品卡紅色左框＋「限時優惠」標籤、規格列顯示「限時優惠 −x%」、每個規格「優惠價」捷徑（展開該規格表單並聚焦原價欄，仍由原表單儲存）、「只看限時優惠（本頁 n）」篩選。**已由 Stage 8 取代**：`admin-products-ui.js` 已刪除，改為 `admin-products-table.js`。

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
- 部署：2026-09-24 經店主驗收後授權上線（見第 6 節上線紀錄與第 7、8 節）。

## 6. 本次成果與待辦

**新增檔案**：`public/admin-icons.js`、`public/admin-shell.js`、`public/admin-overview.js`、`public/admin-orders-ui.js`、`public/admin-products-ui.js`（Stage 8 已刪除）、`public/admin-sheets.js`、`public/admin-shell.css`、`public/admin-pages.css`、`public/admin-forms.css`。
**修改檔案**：`public/app.js`（+1 import、+1 `initAdminShell({...})` 接線，約 10 行）、`public/index.html`（+3 個 CSS link）。`styles.css`、Worker、SQL 均未修改。

**店主驗收**：2026-09-24 店主確認新版後台 OK，本計劃結案。收款帳戶與庫存調整表單刻意保留在頁面上（編輯帳戶會直接聚焦欄位、庫存調整是該頁主要動作）。

**上線紀錄**：2026-09-24 部署 Version ID `ded8db43-575b-4b8a-abcd-d7b19af626ad`，`wrangler deployments list` 確認 100% 流量。部署前以 Node fetch 比對正式站 16 個靜態檔與本機（扣除本次接線行後完全一致，`index.html` 差異僅為 Worker 動態注入的分享標籤），確認未夾帶他人未上線修改。部署後 smoke 16 項全過：health／config／catalog／首頁含 3 個新 CSS／CSP 無 unsafe-inline／未登入 `/api/admin/dashboard` 回 401／7 個新 JS 與 3 個新 CSS 皆 200 且含 marker；正式首頁以訪客身分載入無 console 錯誤、後台外殼已初始化。
**原上線步驟**：依 `AGENTS.md`「Cloudflare 部署穩定流程」：`node --check`、`npm run typecheck`、`git diff --check`、`npx wrangler deploy --dry-run --minify` → `npx wrangler deploy --minify` → smoke 檢查正式 `admin-shell.css`／`admin-shell.js` 可取得（200）與首頁無錯誤。回退：移除 `index.html` 兩個 CSS link 與 `app.js` 的 import／初始化即可。

## 7. 上線後修正（2026-09-24）
**Status**：Complete（部署 Version ID `4ac77490-da40-42a7-82a5-5da6f040a431`；前一版 `ded8db43-575b-4b8a-abcd-d7b19af626ad`）
- 店主回報：手機新增／編輯優惠券只出現淡灰色畫面，點一下又回到原畫面。原因：滑出面板（`position:fixed`）位於後台捲動容器內，iOS／LINE WebKit 會把 fixed 元素困在捲動容器圖層（被外層遮罩蓋住，或跟著捲動內容定位到畫面外），只剩遮罩可見。修正：面板開啟時移到 `#admin-dialog` 最外層、關閉時放回 `<details>`（`admin-sheets.js`）；控制項樣式同時涵蓋 `.admin-sheet-panel`（`admin-forms.css`）；捲動容器改回 `-webkit-overflow-scrolling:auto`（`admin-shell.css`）。
- 同時修正：在「新增商品」面板按「新增分類」時，分類面板會被立即關閉（一次一個面板的邏輯保留了錯的那個）。
- 店主以手機確認灰畫面已修正，但回報 Safari 優惠券面板「點擊錯位」（2026-09-24，部署 `0d738d08-87ee-42a0-93da-fa44ec05f59f`）。推定原因：`editCoupon` 對已在 fixed 面板內的表單呼叫 `scrollIntoView({behavior:"smooth"})`，iOS Safari 會捲動整頁，fixed 元素點擊判定因此位移；開啟面板即自動聚焦輸入框、彈出鍵盤也會造成同樣位移。修正：表單在面板內時不再 `scrollIntoView`（`app.js`）；觸控裝置開啟面板改聚焦標題、不自動彈鍵盤，面板內容捲回頂端；開啟面板時記住整頁位置，輸入框失焦（鍵盤收起）後與關閉面板時捲回（`admin-sheets.js`）。正式站 375px 觸控模擬確認：聚焦在標題、面板位於 dialog 最外層、中央點擊命中面板；Chromium 無法重現 Safari 整頁位移；店主 2026-09-24 以 iPhone Safari 確認正常。
- 店主以 iPhone Safari 回報：進後台後下半部被截斷、無法操作，按瀏覽器「上一頁」才恢復（2026-09-24，部署 `a2cd34ca-24a0-4224-a154-daafbae17832`、`220b4829-b710-43ec-bb90-41c50669de5a`）。推定原因：「管理後台」按鈕在頁尾，開啟時整頁已捲到底；`showDialog` 先 `showModal()` 讓後台進入 top layer，之後才鎖定頁面（body `position:fixed`，整頁捲動位置由數千 px 歸 0），iOS Safari 沿用舊捲動位置的繪製與點擊範圍；「上一頁」觸發 `popstate` 重排後才恢復。修正：`showDialog` 改為先鎖頁面再 `showModal()`（所有 dialog 共用）；另因 `html` 設 `scroll-behavior:smooth`，關閉視窗還原位置與面板還原位置改用 `behavior:"instant"`，避免關閉後整頁從頂端滑回、滑動中點擊位置再次位移。正式站 375px 觸控模擬：從頁尾（捲動 2795px）開後台 → 滿版 812px、內容可捲到底 → 編輯優惠券面板位於最外層、儲存鈕與欄位點擊命中 → 關閉後立即回到 2795px。Chromium 無法重現 Safari 行為；此輪修正仍未解決，見下一項。
- 上一項修正後問題仍存在；店主提供 iPhone Safari 錄影（2026-09-24，部署 `3e5a3c68-6059-4048-8fdd-caa663932f00`）。逐格比對確認真正原因：8.44s 載入中（內容未超出畫面）完整繪製；8.72s 概況資料載入、內容變長後，畫面停在「載入中高度」（重新整理／測試 Telegram 列）被截斷且無法點擊，之後不再變化。即 iOS Safari 對 top layer dialog 內的捲動容器，若首次繪製時內容未溢出便不建立捲動圖層，內容長高後也不更新繪製與點擊範圍；「上一頁」觸發重排才恢復。修正：`.admin-content::after`（absolute、高度 `100% + 1px`）讓容器從第一次繪製起就可捲動（`admin-shell.css`）；`admin-shell.js` 以 ResizeObserver 監看內容高度，變動時切換一次 `overflow-y` 強制重建捲動圖層並保留捲動位置。正式站實測：開啟當下溢出 1px（未修正時為 0，即觸發條件）、載入後溢出 701px 並執行一次重建、內容可捲到底、inline style 已還原。前兩項（先鎖頁再開啟、instant 還原）保留，屬正確性改善。店主 2026-09-24 以 iPhone Safari 確認後台已可正常使用。
- 驗證（本機測試台，375／1280）：捲到優惠券列表 1418px 深處按編輯，面板仍滿版顯示於螢幕、中央點擊命中面板；6 個面板開關、Esc、放回原位皆正常；儲存失敗時面板與內容保留、錯誤提示顯示於面板上方；成功後自動關閉。Chromium 無法重現 iOS 圖層行為；店主已以手機確認灰畫面修正（後續點擊錯位見上方）。

## 8. 商品與規格頁改版（Stage 8，2026-09-24 業主要求）

**Goal**：正式後台「商品與規格」改成 redesign-preview `admin.html#products` 的版面：一列一個規格的表格（手機為逐行標籤卡片）、搜尋＋分類＋現貨／預購＋狀態（含限時優惠）篩選與「＋」新增、每列「上架」開關與「優惠價」「編輯」滑出面板。
**範圍（業主決定）**：只改版面；不做「可售／保留」（需改 Worker），庫存欄顯示「庫存・安全庫存」；上架開關先跳確認再生效。Worker、SQL、API 不修改。
**做法**：新模組 `public/admin-products-table.js`＋`public/admin-products-table.css`；`app.js` 的 `renderAdminProducts` 改為呼叫新模組（商品／規格表單標記一併移入新模組，欄位與送出格式不變，仍由 `submitDynamicAdminForm` 以 document 委派儲存）；`admin-sheets.js` 開放動態面板；移除被取代的 `admin-products-ui.js` 與其 CSS。上架開關以現有 `PATCH /api/admin/variants/:id`、送出與規格表單相同的完整欄位，成功後只更新該列（不重新載入整頁，降低後台限流壓力）。
**Success Criteria**：舊版可編輯的欄位在新版都有位置（商品：名稱、分類、排序、說明、限購、不積點、上架、照片、展示設定；規格：名稱、SKU、類型、售價、原價、安全庫存、訂金、預計到貨、排序、賣貨便連結、上架）；上架開關確認後才送出；手機／平板／桌機無橫向溢出。
**Tests**：正式站以測試商品：改售價再改回、設定原價再清除、上架開關切換兩次回原狀（確認視窗可取消）、編輯商品資料儲存；確認 DB 與前台一致、audit 有紀錄；375／768／1440 版面。
**Status**：Complete（2026-09-24 部署 `6bcafd9a-c1d6-40e0-9312-4efb9252cffc`，修正後 `b62ef7b4-4c50-4959-a55f-80139c6c2a00`）。正式站以店主登入、未上架商品「UX-11衝擊龍神」實測，測前記錄 DB 基準：
- 上架開關：確認視窗「取消」「Esc」「點遮罩」皆不送出（0 次 PATCH）、焦點回到開關、後台不關閉；確定下架 → DB 僅 `is_published` true→false，其餘 10 個欄位與基準相同，audit 新增 `update product_variant`；再確定上架回到基準。
- 優惠價：預覽「NT$1,680 劃線 → NT$1,280，限時優惠 −24%」；儲存後面板自動關閉、列表顯示劃線與 −24%，DB 僅 `compare_at_price` 變 1680；清空再儲存回 null。
- 編輯：商品與規格所有欄位值與 DB 一致；不改內容儲存 → DB 商品欄位不變、audit 新增 `update product`、面板保持開啟；照片、展示設定、「新增規格」（預選本商品）、「＋」（開啟新增商品）皆正常。
- 篩選：分類／現貨／預購／限時優惠／未上架結果正確。版面：1440 表格（無橫向溢出）、768 兩欄卡片、375 單欄卡片；觸控目標 44px、開關 48×28。
- 測後修正（`b62ef7b4`）：開關擴大點擊區左右各溢出 2px；商品未上架時「上架」確認文字改為直接說明前台仍不顯示；頁首三個面板按鈕在 ≥761px 排成一列。
- 測試資料皆已還原（UX-11 售價 1280、無原價、規格上架、商品未上架）。
- 店主 2026-09-24 以手機確認新版商品頁沒問題；程式已提交 `a646cbf`。

## 9. 畫面內確認取代 window.confirm（2026-09-24）

**原因**：照片刪除曾因系統確認框在部分瀏覽器／內嵌 WebView 被略過而無作用（PRODUCT_SHOWCASE_PLAN 第九輪）。後台其餘 6 處 `window.confirm` 有相同風險。
**做法**：新增共用 `public/admin-confirm.js`（`adminConfirm({ title, message, confirmLabel, danger, trigger })` 回傳 Promise<boolean>；取消、Esc、點遮罩皆為 false；前一個確認未回覆又觸發時視為取消），樣式移到 `admin-forms.css` 並新增危險動作紅色按鈕。`app.js` 6 處改為 `await adminConfirm(...)`：通知重新排入、立即發送生日券、會員點數調整（扣點為紅色）、訂單狀態更新（取消／退款為紅色）、退貨驗收、尾款與運費入帳。三個表單送出函式皆在第一行 `event.preventDefault()`，改為非同步確認不會觸發原生送出。商品上架開關改用同一模組（下架為紅色）。文案不變，改為「標題問句＋說明」。前端已無 `window.confirm(`。
**Status**：Complete（部署 `d3241da1-4847-427a-8636-b2e482411187`）。正式站以店主登入實測（皆按取消、以臨時紀錄確認 0 筆寫入請求）：生日券、扣點（紅色「確定扣除」）、通知重新排入三種確認文案正確。店主重新登入後補測訂單：狀態更新（退款處理中，需先填原因才會出現確認，原有驗證不變）顯示紅色「確定更新」與退款庫存說明；退貨驗收顯示「收到 1 件，其中可再售 1 件、報廢 0 件。」；兩者預設焦點在「取消」、Esc 只關確認不關後台，皆 0 筆寫入請求，測試填入的欄位已還原。尾款與運費確認：正式資料目前沒有可填尾款的訂單，未實測（與其他五種共用同一模組與呼叫方式）。另記錄既有問題：登入過期後頁首仍顯示會員名稱。

## 10. 登入過期後頁首仍顯示會員名稱（2026-09-24）

**原因**：前端只在載入頁面時以 `/auth/v1/user` 驗證一次 token；Supabase access token 約 1 小時到期，頁面不會再檢查或換發，也沒有任何程式把頁首改回未登入（`clearStoredAuthSession` 只清資料不更新畫面）。頁面開著超過到期時間後，頁首仍顯示名稱與「管理後台」，但所有會員／後台 API 都回 401「登入已過期」。
**修正**：新增 `public/auth-expiry.js`（`app.js` 只接線）：登入成功後依 token 的 `exp` 排程到期檢查；分頁從背景回到前景時補檢查（休眠時計時器會暫停）；後台 API 回 401 也觸發。到期時先嘗試恢復（LINE App 內用既有保存工作階段 `restorePersistentLiffSession`），失敗才清除登入資料、頁首改回「LINE 登入」並隱藏「我的訂單」「管理後台」、關閉後台與訂單視窗，提示「登入已過期，請重新登入」。
**Status**：Complete（部署 `f12d9aeb-0969-400a-834d-969974b565d3`）。正式站以店主登入、開著後台時模擬時間超過 token 到期：頁首由會員名稱改為「LINE 登入」、兩個按鈕隱藏、後台自動關閉、顯示提示、`sessionStorage` 登入資料已清除。後台 API 回 401 的觸發路徑為同一函式，未另外實測。
**未做（可另議）**：一般瀏覽器內到期前以 refresh token 自動換發，讓管理員不必每小時重新登入；涉及登入流程，需業主決定。
