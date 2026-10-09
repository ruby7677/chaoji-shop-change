# 潮吉好頑：專案工作指引

## 定位與檔案

本指引只適用此目錄。工作目錄為 `app/`，使用 PowerShell、原生 HTML/CSS/JavaScript、TypeScript Worker、Supabase；沒有前端框架或 bundler build 指令。

- 正式前端入口：`app/public/index.html`、`app/public/app.js`（事件接線、商品頁與開機流程）。登入相關：`liff-session.js`（執行設定、LIFF 啟動情境、登入回呼、session 保存／還原與 LIFF 橋接）、`auth-return-state.js`（登入前後的頁面與結帳還原）、`auth-boot.js`（開機遮罩）、`member-profile.js`（會員載入、身分同步、會員資料表單、LINE 登入入口），結帳流程 `checkout-flow.js`（結帳範圍與送出訂單）。前台模組：`storefront-catalog.js`（型錄與 Hero）、`cart.js`（購物車與雲端同步）、`checkout-form.js`（結帳表單）、`member-benefits.js`（點數與 LINE 好友）、`member-orders.js`（我的訂單與回報匯款；訂單卡與付款明細畫面在 `order-views.js`，與獨立訂單頁共用），獨立訂單頁 `orders.html`／`orders-page.js`／`orders-session.js`（LINE 圖文選單與訂單通知「查看訂單」開啟，LIFF ID 為 `wrangler.jsonc` 的 `ORDERS_LIFF_ID`，不載入型錄）、`app-core.js`（前後台共用：`auth` 狀態、狀態文字、對話框、toast），商品頁與輪播 `product-*.js`、`hero-*.js`，LINE LIFF `liff-auth.js`、登入續期 `web-session.js`／`auth-expiry.js`。後台：`admin-app.js`（狀態、分區載入、分頁切換）、各分頁 `admin-*-panel.js`、`admin-product-image.js`，以及外框／概況／表格等 `admin-*.js`。
- 前端樣式依原 cascade 順序拆成 `styles.css`（基礎）→ `storefront-refinements.css` → `admin-operations.css` → `storefront-details.css` → `admin-mobile-layout.css` → `admin-mobile-lists.css`，再接功能 CSS（`product-*.css`、`admin-*.css`…）。`index.html` 的 `<link>` 順序就是 cascade 順序，不可調換；新樣式放對應功能檔或新檔。前台連續的樣式在 `index.html` 以合併檔載入（`bundle-base.css`、`bundle-storefront.css`），成員與順序定義在 `app/scripts/build-css.mjs` 的 `CSS_BUNDLES`：編輯原始檔後執行 `node scripts/build-css.mjs`（`wrangler dev`／`deploy` 也會自動執行，`tests/frontend/css-bundles.test.mjs` 會擋下過期的合併檔）；新增前台樣式檔時加進對應的合併段，不要另外在 `index.html` 加 `<link>`。後台樣式（`data-admin-href`）不可併入，需留在原位置。
- Worker：`app/src/index.ts` 只有路由與排程入口；`env.ts`（Env 型別）、`http.ts`（安全 header／CSP、json、rate limit）、`auth.ts`（LINE／LIFF 驗證、`requireUser`／`requireAdmin`）、`member-api.ts`、`catalog.ts`、`notifications.ts`、`database-errors.ts`、後台 `admin-dashboard.ts`／`admin-overview.ts`／`admin-orders.ts`／`admin-settings.ts`／`admin-catalog.ts`；另有 `product-showcase.ts`（商品頁與多圖 API）、`product-image-storage.ts`（圖片儲存與邊緣快取）、`share-meta.ts`（分享預覽）、`canonical-host.ts`（`LEGACY_HOST` 的 workers.dev 網頁 GET／HEAD 301 轉到 `CANONICAL_HOST`，`/api/*` 不轉；新增入口頁要同時列入 `run_worker_first` 才會被轉址）、`notification-delivery.ts`（通知寄送）、`auth-session.ts`／`liff-session-vault.ts`／`web-session.ts`（登入工作階段）。
- LINE 訊息文案：`app/src/line-notification-messages.ts`。
- DB：`app/supabase/migrations/`；部署：`app/wrangler.jsonc`。
- Git 根目錄可能在上一層並包含其他專案；用指定路徑查看 diff、暫存與提交，避免 `git add .`。
- 單檔維持在 500 行內：新功能放新的 ES module（`public/*.js`）、新 CSS 檔或 `src/*.ts` 模組，入口檔只加 import 與接線。ES module 不能重新指定別的模組的 `let`：跨模組修改狀態要由擁有該狀態的模組匯出函式（例：`invalidateBankAccounts()`、`forgetCartSyncUser()`、`selectCheckoutScope()`、`captureAuthReturn()`、`resumePendingReturnCheckout()`）。
- CSP 無 `unsafe-inline`：動態 HTML 不可寫 `style="…"` 屬性（改用 class 或 `el.style.setProperty()`）；圖片只能走同源 Worker；修改 `index.html` 的 `auth-boot-critical` inline style 必須同步更新 `src/http.ts` 的 CSP hash。`src/http.ts` 的 `SECURITY_HEADERS` 與 `public/_headers` 必須一致（靜態檔由資產層直接回應、不經過 Worker，只有 `wrangler.jsonc` 的 `run_worker_first` 列出的路徑才執行 Worker）。
- 進行中的功能規劃放在 `app/*_PLAN.md`（例：`app/PRODUCT_SHOWCASE_PLAN.md`），實作前先讀對應規劃並更新各 Stage 狀態。

## 範圍與讀取順序

先確認使用者本次目標與相關 dirty diff，再用 `rg -n` 找元件、函式與呼叫點。讀取足以理解變更的上下文，不預設整份載入所有 JavaScript、SQL、交接書或需求歷史；排除 `node_modules/`、`.wrangler/`、壓縮檔與其他專案。

使用者最新明確決策決定目標；程式、已套用 migration 與實際設定決定目前行為。文件描述不等於已完成或已部署。涉及衝突先確認差異，不能以舊文件覆蓋新決策。

長文僅按任務讀取：後台 UI 查 `app/ADMIN_REDESIGN_PLAN.md`、前台商品展示查 `app/PRODUCT_SHOWCASE_PLAN.md`（已完成的交接、提案、Supabase 審查與階段報告在 `app/docs/history/`，內容以當時為準，僅作背景）；Auth 設定查 `app/SUPABASE_SETUP.md`；安全作業查 `app/SECURITY_OPERATIONS_CHECKLIST.md`。`PRODUCT.md`、初期需求與交接書含歷史資訊，版本號、店址、運費與登入狀態需核對。

## chaoji-shop-change Skill 載入規則

`.agents/skills/chaoji-shop-change/SKILL.md` 是本專案跨層交易流程的任務專屬 SOP，不被本檔其他一般工具規則取代。

- 任務只要涉及購物車、結帳、訂單、付款、庫存、點數／優惠券交易結果、LINE／Telegram 通知、管理員／會員權限、Supabase 資料一致性，且需要跨前端、Worker、SQL／RPC／RLS 其中兩層以上追查或修改，開始分析或修改前必須重新讀取該 Skill。
- 單純文案、純 CSS 視覺小改、與交易流程無關且只改單一前端層的 UI 微調，不強制載入。
- 每個符合條件的任務都讀取 Skill 檔案的目前內容，不以先前讀過的印象代替：檔案可能已更新，而接續的工作階段（新聊天、重新連線、恢復的 worker）不一定保有先前讀到的內容。恢復中斷的實作前，同樣先重新讀取 `AGENTS.md` 與該 Skill。
- 新建立的 `luna_worker` 若承接符合上述條件的任務，委派內容必須明確要求它自行讀取 `AGENTS.md` 與 `.agents/skills/chaoji-shop-change/SKILL.md`；不可假設主代理讀過即等同 worker 已讀。
- 若 Skill 對某項分析、驗證或工具使用有更具體要求，以 Skill 的任務專屬規則為準；MCP 穩定性規則只處理工具 discovery、連線與重試，不得用來跳過 Skill 規定的檢查。

## MCP／本機工具穩定性規則（Codex）

本節只適用 Codex 環境，只規範 Chat On Steroids／MCP 本機工具的 discovery、連線、session 與 stale catalog 恢復策略，不改變專案業務規則、Skill 流程或驗收標準。

- 本機專案操作優先使用目前 catalog 中可用的 `mcp__Chat_On_Steroids_Core__*` 工具；Core 可用時，不在 Core、Plugins、`gpt_tunnel` 之間任意切換。
- 不假設任何 MCP tool handle 永久有效。真正呼叫工具前應以當下 `ALL_TOOLS` 為準解析最新工具名稱，不長時間保存先前取得的 tool object 後再呼叫。
- 若收到 `UNKNOWN_TOOL`、`stale catalog` 或工具名稱不在目前 catalog 的錯誤，不得直接重送舊 handle；應立即重新 discovery，再用最新的 Core 工具重試同一操作。相同操作最多重新 discovery／重試 2 次，避免無限迴圈。
- `apply_patch` 若因 stale 失敗，先重新 discovery；若最新 Core `apply_patch` 仍無法使用，可改用最新 Core `exec_command` 做安全的精準修改，但必須先驗證目標路徑與唯一命中條件，避免整檔覆寫、換行格式污染或誤改其他內容。
- 同一個 agents 工作階段必須維持同一 tool family：例如用 Core `agents spawn` 建立的 worker，後續 `message`、`status`、`finish` 也必須走 Core。不得拿 Core 建立的 `run_id`／worker id 改從 Plugins 或 `gpt_tunnel` 接續。
- 若出現 `Invalid connector tool continuation`、`Code Mode continuation is no longer available`、MCP 重連或 catalog 大幅刷新，視為原 continuation／tool handle 已失效；重新 discovery，不沿用舊 continuation、舊 tool object 或跨 namespace 的 session id。
- 若 Core 經重新 discovery 後確實不存在或連續不可用，才可改用其他已啟用 tool family；切換時要把它視為新的工具工作階段，不重用前一 family 的 agent/session/continuation 識別碼。
- 工具 stale、重新連線或 fallback 不構成跳過 `AGENTS.md`、Skill、dirty diff 檢查、驗證或安全邊界的理由；恢復連線後先確認目前工作區狀態，再從最後一個有證據完成的步驟繼續。
- 對使用者回報時，只說明實際成功／失敗的操作；catalog stale 造成未送出的修改不得描述成已完成，也不得重播已成功的修改。

## 主代理與 Luna Worker 分工（Codex）

本節只適用 Codex 環境；Claude Code 的對應方式見下一節。Luna Worker 的模型與推理等級以 `C:\Users\user\.codex\agents\luna-worker.toml` 為準；若內建 `luna_worker` 角色無法套用該設定，改用可指定該設定的 worker，維持下列相同分工與安全邊界。

本專案預設採用「主代理規劃與審核、Luna Worker 執行」的協作方式。只要任務包含程式碼／檔案修改、測試、資料操作或部署，主代理應在理解目標與檢查現況後，將邊界清楚、可獨立驗收的實作工作委派給 `luna_worker`。

- 主代理：理解使用者目標、拆解範圍、定義限制與驗收條件、委派工作、審查 Luna 回報與實際差異、補足整合驗證，最後向使用者交付結果。
- `luna_worker`：理解被委派的範圍、規劃最短可靠路徑、執行修改、完成必要測試與驗證，並回報變更、結果、失敗及剩餘風險。
- 委派時須明確指定工作目錄、檔案／模組歸屬、不可修改項目、驗收條件與是否有部署授權；提醒 Luna 共享同一工作樹，不得回復或覆蓋其他人的未完成修改。
- 主代理不應與 Luna 重複實作同一範圍；可進行唯讀調查、規劃、差異審查及必要的整合修正。若需追加工作，優先將具體回饋再次交給同一 Luna 任務。
- 若 `luna_worker` 不可用、反覆失敗或任務無法安全委派，主代理必須先向使用者說明原因與受影響範圍，才可自行接手實作；不得默默略過委派規則。
- 純說明、狀態查詢、唯讀診斷或只需回答問題的任務不強制啟動子代理。

## Claude Code 對應規則

本檔同時供 Codex 與 Claude Code 使用。業務規則、Skill 載入、驗證與部署流程兩者共用；只有工具與分工不同。

- 工具：使用 Claude Code 內建 Read／Edit／Write／Grep／Glob 與 PowerShell（或 Bash）；Chat On Steroids／MCP stale catalog 規則不適用。
- 分工：主代理直接規劃、實作與驗收，不使用 `luna_worker`。唯讀的大範圍搜尋（找呼叫點、對照命名、盤點檔案）可交給子代理，預設模型為 Haiku（`~/.claude/settings.json` 的 `CLAUDE_CODE_SUBAGENT_MODEL`）；子代理只讀不寫，回報的檔案與行號由主代理抽查後才採用。修改檔案、SQL／RPC／RLS、交易流程與部署一律由主代理執行；其他情況只有使用者明確要求時才使用子代理。
- 參考外部網站時用內建瀏覽器讀取 DOM／computed style 取得實際數值，只借鏡互動模式，不複製對方圖片、文案或品牌元素。
- 前端預覽使用 `.claude/launch.json` 的 `worker-dev`（`wrangler dev`，port 8082，含 SPA fallback 與 `/api/*`）；`redesign-preview` 只是靜態 python 伺服器，無法測路由與 API。5714 在此機器被 Windows 保留、8080／3000 已被占用。測試用暫存檔放 scratchpad，完成後刪除。
- 回覆使用繁體中文。

## Cloudflare 部署穩定流程／常見失敗處理

Cloudflare production deployment 必須由單一 deployment owner 統籌，並依下列順序完成；本節規則用來避免平行部署互相覆蓋與 Windows managed sandbox 的已知失敗。

- 同一時間只能有一個 deployment owner。開始 deploy 前先確認 agent 狀態沒有其他代理正在部署；禁止多個 Luna 平行執行 `wrangler deploy`，避免舊 Worker／資產覆蓋新版本。
- Windows managed sandbox 常因 Wrangler 寫入 `C:\Users\user\AppData\Roaming\xdg.config\.wrangler\logs` 觸發 `EPERM`。每次 Wrangler 指令前先設定 task-specific `$env:WRANGLER_WRITE_LOGS='0'`（Wrangler v4.130 的 `shouldLogToDisk` 支援 `false/0`）。禁止用重試同一命令解決；禁止改動 `HOME`／`CODEX_HOME`，也禁止關閉 sandbox／TLS。必要時可將 `WRANGLER_LOG_PATH` 指到 workspace 可寫目錄，但優先關閉 disk logs。
- Windows `Invoke-WebRequest`／`curl` 使用 Schannel 可能出現 `SEC_E_NO_CREDENTIALS`。post-deploy smoke 固定使用 Node.js 標準 `fetch`；不得關閉 TLS 驗證，同一個 Schannel 命令失敗後不要重試。
- Wrangler 4.130 的 `wrangler check` 不是一般 config validation（僅有 startup profile）；不可把它當 deployment gate。固定 gate 為：`npm run check:js`（所有前端 module 的 `node --check`）、`npm run typecheck`、`npm test`、`git diff --check`，以及 `npx wrangler deploy --dry-run --minify`。
- dry-run 前確認 cwd 是 `app/`、`wrangler.jsonc` 的 `name` 為 `chaoji-haowan-shop`、`main` 為 `src/index.ts`（`wrangler.jsonc` 是唯一的部署設定，不要另建指向正式 secrets 或共用 rate limit namespace 的預覽設定）；同時確認本次關鍵 route／marker 存在於 source。dry-run 完成後到正式 deploy 前若工作樹相關檔案有變更，必須重新跑完整 gate。
- 正式部署固定使用 `$env:WRANGLER_WRITE_LOGS='0'; npx wrangler deploy --minify`。只有 exit code 為 0 且輸出 `Current Version ID` 時，才可回報部署成功。
- deploy 後執行 `npx wrangler deployments list --json`，確認最新版本流量為 100%；再用 Node `fetch` 驗證 health、config、catalog、首頁及本次特定 route。受保護 route 未登入應回 401／403；若回 404，視為漏部署。另須 fetch 正式 `app.js`／`styles.css` 檢查本次 marker。
- post-deploy smoke 失敗時先分類為 build、auth、upload、API route 或 client TLS 問題，禁止無差別重 deploy；只有確認 production 版本未更新或 bundle 錯誤時，才可修正後重新部署。
- 交付時記錄 Version ID 與正式 URL；不得把 dry-run、上傳中、log `EPERM` 或規劃描述成完成。

## 已確認產品約束

- 店址民生路二段 **93 號**；正式客服 `@078isxfl` 與結帳測試好友 `@345adwzw` 用途不同。
- 商品格手機 2 欄、平板／桌機 4 欄；手機輸入字體至少 16px；彈窗右上關閉鈕捲動時可見，提示不能被 modal 遮住。
- 預購訂金 50%，海外海運／集運不保證固定到貨天數。
- 付款期限依商品類型：預購訂單成立後 2 小時內完成付訂，現貨匯款訂單 24 小時內完成；逾期自動取消並釋放保留量。
- 建單保留庫存，管理員確認款項才扣庫存；點數完成核銷入帳。維持交易與歷程完整性。
- 賣貨便費用不加進本站訂單；宅配結帳不預收未知運費，到貨後客服通知尾款與實際運費。
- 本站到店取貨與宅配一律匯款／轉帳；賣貨便仍由 7-11 外部收款，不能把賣貨便的 `store_payment` 內部標記誤當成到店現金支付。
- 會員回報匯款只透過 Telegram 通知管理員；管理員確認款項與到貨狀態依事件以 LINE 通知會員、以 Telegram 通知管理員。
- 日期時間一律以台灣時間（Asia/Taipei，UTC+8）顯示、輸入與判斷「今天」：資料庫存 `timestamptz`，前端用 `app-core.js` 的 `formatDateTime`／`formatDate`／`taipeiDateTimeInput*`，Worker 用 `taipeiDate`，訂單編號由 `create_delivery_order` 的函式層級 `timezone` 設定產生；pg_cron 排程時間以 UTC 撰寫並註明台灣時間。
- 店主已選擇 LINE Login＋伺服器端 `is_admin` 管理模式；不因舊 MFA 文件自行重新啟用 MFA。該決策不代表移除工作已部署，需核對現況。

## 驗證與交付

實作任務持續到受影響功能完成、必要檢查通過且相關問題已修正。沿用任務已有授權，安全的本機檢查與修正不逐步請示。診斷／狀態查詢以證據與結論完成；若需新增遠端操作授權，先完成可獨立進行的準備，再交代具體待執行內容。

在 `app/` 執行，依修改類型選必要檢查：

- JS：`npm run check:js`；Worker：`npm run typecheck`；Worker 與前端行為：`npm test`（`tests/worker`、`tests/frontend`，外部服務全部以假 fetch 取代）。
- 所有文字差異：`git diff --check`；UI 另檢查受影響畫面及相關手機／平板／桌機尺寸，語法通過不等於 UI 通過。
- Worker／部署設定修改或準備部署：依「Cloudflare 部署穩定流程／常見失敗處理」執行 `npx wrangler deploy --dry-run --minify`。SQL／RPC／權限修改另跑 `npm run test:db`：在本機 PostgreSQL 16＋pg_cron 從零套用全部 migration、執行 `verify_schema.sql` 與 `tests/db/*.test.sql`（需 bash，會重建 `CJ_TEST_DB` 指定的資料庫，只能指向測試用資料庫）；Windows 無此環境時以 GitHub Actions `CI` 的 database job 結果為準。新增交易規則要在 `tests/db` 補對應的允許／拒絕案例；沒跑的測試不可宣稱已通過。
- SQL／付款／庫存／權限須驗證允許與拒絕案例，不能只以編譯或健康端點代替；未做實測須清楚註明。
- 已套用 SQL 以新增增量 migration 修正，不能全量重跑。正式 DB 的 migration 紀錄（`supabase_migrations.schema_migrations`）與 `app/supabase/migrations/` 檔名一一對應（12 碼版本）：套用前以 `npm run db:history-sql` 產生的唯讀 SQL 確認只有新檔案是 `missing_in_history`；以 Supabase MCP `apply_migration` 套用時 `name` 用檔名去掉版本號的部分，套用後執行 `npm run db:history-sql -- align` 產生的 SQL 把時間戳版本改回檔名版本，再跑一次唯讀檢查確認 0 列（Supabase CLI `db push` 會直接寫入檔名版本）。
- 新 migration 修改既有函式時寫出完整的 `create or replace function`；不要用 `pg_get_functiondef` 取出原始碼再 `replace()` 修補，因為修補結果無法從 migration 檔直接讀出，也容易因原始碼差異而靜默失效。已套用的舊 migration 保留原樣。要查某支函式目前生效的完整定義：GitHub Actions `CI` 的 database job 會上傳 `effective-db-functions` artifact（套用全部 migration 後 `public`／`private` 的函式定義）；本機可設定 `CJ_FUNCTION_SNAPSHOT=<檔案路徑>` 再跑 `npm run test:db`。
- 不輸出 `.env`／`.dev.vars`／token；不以可編輯 `user_metadata` 授權。會員不能自行變更管理員或 LINE 綁定欄位。
- 部署、SQL 套用與通知測試依任務已有授權執行，不因本指引擴大授權；文件變更不需部署。網路／權限失敗先判斷原因，不重複相同命令，也不關閉 TLS 驗證。
- 回覆簡短交代結果、驗證與未完成部分；僅在實際成功後報部署版本。不把規劃寫成完成。

檢查通過後，只有新增變更、失敗或未解疑點才重跑。純文件修改檢查內容、連結與格式即可，不啟動應用程式或部署。維持使用者選定的模型與推理等級。
