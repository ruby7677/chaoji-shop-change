# 尾款匯款末五碼：網站回報＋後台核對＋Telegram 通知

## 目標

預購訂單到貨後，客人在「我的訂單」匯尾款（含運費）後，可以直接在網站填寫尾款匯款帳號末五碼。這筆末五碼會出現在後台供管理員核對，同時發 Telegram 通知管理員。目前做法是請客人把末五碼私訊給小幫手。

觸發條件 → 預期結果：會員在自己的預購訂單到貨後、尾款尚未確認前送出 5 位數字 → 訂單記錄會員回報的末五碼與時間（狀態不變），Telegram 收到「已匯尾款並回報末五碼」通知；後台確認尾款時，表單已預先帶入這個末五碼。

## 現況（2026-10-29 核對）

- **訂金回報**：`submit_order_payment`（最新定義在 `202610250001_preorder_report_extends_deadline.sql`）只接受 `status = 'pending_payment'`、期限內的訂單，成功後狀態改為 `pending_review`。到貨訂單（`partially_ready`／`ready_for_pickup`）呼叫會得到 `ORDER_NOT_PAYABLE`，所以不能沿用。
- **尾款確認**：管理員用 `admin_update_order_fulfillment`（最新定義在 `202610120002_home_paid_in_full_completion.sql`）勾選「已確認尾款」，並手動輸入 `final_payment_last_five`。每次儲存時，如果沒有勾選確認，會把 `final_payment_last_five` 清成 null，所以會員回報的值不能存在這個欄位，必須另開欄位。
- **到店取貨不在這條流程裡**：到店取貨不能用這個函式確認尾款（`SHIPPING_FEE_STORE_PICKUP`），完成時 `admin_transition_order` 直接把 `paid_amount` 設為 `amount_due`。
- **Telegram 通知會被擋掉**：會員回報觸發的通知是 `payment_reported`，event key 是 `payment_reported:<orderId>`（`src/notifications.ts`）。同一筆訂單回報訂金時已經用過這個 key，回報尾款會被當成重複而不送出，所以要另開事件類型。
- **讀取權限**：會員讀訂單時用會員 JWT 走 RLS。`orders` 開放給 authenticated 的是整張表的 SELECT 權限（`202609140001_security_hardening.sql`），新欄位不必另外 grant，但要加進 `MEMBER_ORDER_SELECT`。

## 決策

1. **範圍**（2026-10-29 已決定）：只做交貨便與宅配預購。到店取貨維持現狀，因為資料庫沒有到店取貨的「確認尾款」步驟，取貨完成就視為付清。
2. **重複回報**（2026-10-29 已決定）：管理員確認尾款前可以改填，每次改填都再發一次 Telegram，後台顯示最後一次回報的內容與時間。
3. **回報後狀態要變嗎？**（2026-10-29 已決定：不改）資料庫狀態維持到貨狀態，只記錄回報內容；畫面依回報時間顯示「已回報尾款，待確認」。理由：改回 `pending_review` 再確認會重複扣庫存、會被逾期排程取消，也會觸發 LINE 狀態通知。後台概況待辦顯示「會員已回報末五碼 12345」。

## Stage 1：資料庫

**Goal**：新增會員回報尾款用的欄位與 RPC。
**Success Criteria**：允許與拒絕的案例都在 `tests/db` 驗證通過。
**Tests**：新增 `tests/db/final_payment_report.test.sql`。
**Status**：Complete

- 新 migration `202610290001_member_final_payment_report.sql`：
  - `orders` 新增兩個欄位：`final_payment_reported_last_five text`，限制為 null 或 `^[0-9]{5}$`；`final_payment_reported_at timestamptz`。
  - 新增 `public.submit_order_final_payment(p_order_id uuid, p_payment_last_five text) returns boolean`，`security definer`，`set search_path = ''`，只 grant execute 給 authenticated，其餘角色 revoke。條件：
    - 已登入，且 `member_id = auth.uid()`；
    - 有預購品項、`delivery_method in ('cvs_delivery', 'home_delivery')`、`status in ('partially_ready', 'ready_for_pickup')`、`bank_account_id` 不是 null、`final_payment_confirmed_at is null`、`amount_due > paid_amount`；
    - 宅配另外要求運費已確認（`shipping_fee_notified_at is not null`）；
    - 不符合時丟出 `FINAL_PAYMENT_NOT_REPORTABLE`，格式錯誤時丟出 `INVALID_PAYMENT_LAST_FIVE`。
  - 寫入回報欄位，以及 `updated_at`。
  - 不另寫歷程表：狀態沒變，回報內容以兩個欄位為準，每次改填的 Telegram 通知就是歷程。
- `admin_update_order_fulfillment` 不用改：它不碰新欄位，管理員確認時照舊寫入 `final_payment_last_five`。
- 測試案例：
  - 允許：交貨便到貨；宅配到貨且運費已確認；確認前再次改填。
  - 拒絕：未登入、別人的訂單、現貨訂單、到店取貨、還沒到貨（confirmed）、尾款已確認、宅配運費未確認、非 5 位數字、已取消。
- `src/database-errors.ts` 加上 `FINAL_PAYMENT_NOT_REPORTABLE` 的中文訊息。

## Stage 2：Worker 與 Telegram

**Goal**：提供 `POST /api/orders/:id/final-payment`，成功後通知管理員。
**Success Criteria**：會員送出後 Telegram 收到含末五碼與金額的訊息，LINE 不發給會員。
**Tests**：`tests/worker` 用假 fetch 驗證路由、限流、錯誤對應、訊息內容與 event key。
**Status**：Complete

- `src/member-api.ts`：新增 `submitOrderFinalPayment`，跟訂金回報一樣做 `requireUser`、限流（`payment:<userId>`）並檢查 5 位數字，再以會員 JWT 呼叫 RPC。`MEMBER_ORDER_SELECT` 加上兩個新欄位。
- `src/index.ts`：加入路由，成功後執行 `ctx.waitUntil(notifyOrderEvent(env, id, "final_payment_reported"))`。
- `src/notifications.ts`：
  - `loadOrderNotification` 加讀新欄位；
  - event key 用 `final_payment_reported:<orderId>:<final_payment_reported_at>`，改填時會再通知一次；
  - 新事件只發給 Telegram，`routeOrderNotificationRecipients` 要把它和 `payment_reported` 同樣排除 LINE。
- `src/line-notification-messages.ts`：新增事件類型與文案。Telegram 範例：
  ```
  【潮吉好頑選物】
  訂單編號：CJ-261029-183823-8A58
  訂單狀態：會員已匯尾款並回報末五碼
  會員名稱：○○○
  商品：CX-20鳳凰武力改造組 ×1
  取貨方式：7-11店到店(交貨便)
  尾款／運費：NT$1,560
  尾款末五碼：12345
  ```
- `OrderMessageData` 加入 `finalPaymentReportedLastFive`。
- 文案同步：`homeBalanceReport`「匯款後請回覆末五碼給小幫手」改成「匯款後請在「查看訂單」回報末五碼」。

## Stage 3：前台「我的訂單」與獨立訂單頁

**Goal**：交貨便與宅配的預購到貨卡片可以回報尾款末五碼。
**Success Criteria**：回報成功後卡片顯示「已回報末五碼 12345，待小幫手確認」，並可以改填；尾款確認後隱藏。手機、平板、桌機都檢查過。
**Tests**：`tests/frontend` 驗證訂單卡、付款對話框的模式與送出流程。
**Status**：Complete

- `public/order-views.js`：
  - 交貨便到貨卡片的匯款帳號下方加「回報尾款末五碼」按鈕（沿用 `data-order-payment`）；
  - 宅配的 `paymentOrderView` 在 `balance` 模式下開放末五碼欄位；
  - `reportPayment()` 遇到可回報尾款的訂單改呼叫新的 API；
  - 帳號卡的提示文字改成「匯款後請在下方回報末五碼」。
- 付款對話框新增 `final_payment` 模式：`applyPaymentFormMode` 顯示末五碼欄位，送出時改走新的 API。
- 首頁（`app.js`／`member-orders.js`）與獨立訂單頁（`orders-page.js`）的點擊處理都要接上。
- 改動 import 後執行 `node scripts/build-modulepreload.mjs`，改 CSS 後執行 `node scripts/build-css.mjs`。
- `order-views.js` 目前 176 行，加完後若接近 500 行，就把尾款相關的程式拆到新模組 `order-final-payment.js`。

## Stage 4：後台核對

**Goal**：管理員在訂單卡上看得到會員回報的尾款末五碼，確認尾款時表單已預先帶入。
**Success Criteria**：有會員回報時，後台訂單卡與概況待辦都看得到；確認表單預先帶入，但仍可修改。
**Tests**：`tests/frontend` 驗證後台訂單卡與概況的顯示內容。
**Status**：Complete

- `src/admin-dashboard.ts`、`src/admin-overview.ts`：查詢欄位加上兩個新欄位。
- `public/admin-orders-panel.js`：
  - 訂單卡顯示「會員回報尾款末五碼：12345（時間）」；
  - 尾款確認表單的 `final_payment_last_five` 預設帶入會員回報的值；
  - 搜尋也能用尾款末五碼找訂單。
- `public/admin-overview.js`：「店到店／宅配尾款」待辦的說明，有回報時顯示「會員已回報末五碼 12345・待收 NT$1,560」，並把它列為較急的待辦。

## 驗證與上線順序

1. 本機跑 `npm run check:js`、`npm run typecheck`、`npm test`、`git diff --check`。資料庫改動以 GitHub Actions `CI` 的 database job（`npm run test:db`）結果為準。
2. **先套 migration**：先用 `npm run db:history-sql` 確認只有新檔案是 missing；由使用者自行套用（Claude Code 自動模式會擋正式資料庫 migration），套用後執行 `npm run db:history-sql -- align` 對齊版本號。
3. **再部署 Worker**：依 AGENTS.md 的部署流程跑完 gate、dry-run，再正式部署，最後跑 smoke。新的 API 未登入時應回 401；如果回 404，代表漏部署。
4. 不用正式訂單測試回報；Telegram 只檢查離線產生的訊息文字。真的發一則測試通知需要另外取得授權。
