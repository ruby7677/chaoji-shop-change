# 後台批次操作規劃

來源：第三次 `/impeccable critique`（30/40）剩餘的 P2「沒有批次操作」（啟發式 7 彈性與效率 2 分）。

## 現況（2026-09-28 核對程式）

- 單筆訂單狀態轉換：`POST /api/admin/orders/:id/transition` → Worker `transitionAdminOrder`（部分狀態先讀訂單檢查配送／預購條件）→ RPC `admin_transition_order`（單筆交易：確認款項時扣庫存、寫狀態歷程與稽核）→ 成功後 `waitUntil` 送 `notifyOrderEvent(status_changed)`（會員 LINE＋管理員 Telegram）與 `notifyLowStock`。
- 單筆規格上下架：`PATCH /api/admin/variants/:id`，前端送出整筆規格資料（`variantPayload`），後端更新後清型錄快取。
- 前端已有：一鍵確認款項（`isQuickConfirmable`／`paymentConfirmation`）、下一步表單、訂單狀態兩層分組、商品表格列。

## 範圍決策（店主 2026-09-28 選定）

| 動作 | 納入批次 | 理由 |
|---|---|---|
| 規格上架／下架 | 是 | 低風險、可逆 |
| 完成取貨（ready_for_pickup／confirmed／partially_ready → completed） | 是 | 到店取貨常一次多筆 |
| 確認款項 | 否（店主決定維持逐筆，已有一鍵確認） | 每筆需核對末五碼與金額 |
| 取消／退款 | 否 | 必填原因、會反轉庫存，逐筆處理 |

每批上限 **10 筆**；做法為 **前端逐筆呼叫既有單筆 API**（後端與 SQL 不改）。

### 完成取貨的既有規則（`admin_transition_order`，202609110005 起）
- 到店取貨完成時 `paid_amount` 設為 `amount_due`：**完成＝視為尾款已收**，並觸發完成訂單時的點數入帳。
- 非到店取貨（宅配、賣貨便）必須已有 `final_payment_confirmed_at`，否則 `FINAL_PAYMENT_REQUIRED`；前端卡片已在沒有尾款確認時隱藏「完成」。
- 因此批次完成的確認視窗必須逐筆列出「待收尾款」，有尾款的訂單標示「完成即視為已收 NT$…」，並顯示尾款合計。

## 實作方式

- 每筆仍是獨立交易，驗證、歷程、稽核、點數與通知（會員 LINE＋管理員 Telegram）行為與單筆相同。
- 依序送出（不平行），顯示進度（第 k／N 筆）。
- 部分成功：失敗項目保留勾選並顯示原因，成功項目從清單消失，可重試失敗項目。
- 不採用：Worker 批次端點（只省往返）、SQL 單一交易（一筆不符整批失敗、需 migration）。

## Stage 1：純邏輯與測試
**Goal**：`public/admin-batch.js`（純函式）：
- 可批次完成的訂單：可執行動作包含 `completed`（沿用卡片上的轉換過濾，含宅配需尾款確認）。
- 上限 10 筆檢查。
- 批次完成確認內容：逐筆訂單、會員、待收尾款，尾款合計，有尾款者附「完成即視為已收」提示。
- 批次上下架確認內容：規格清單、目標狀態、商品未上架時的提示。
- 結果彙整（成功／失敗＋原因）。
**Tests**：`tests/frontend/admin-batch.test.mjs`：可／不可批次、超過上限、尾款合計、未上架商品提示。
**Status**：Complete（訂單卡的轉換規則同時抽成 `availableTransitions()`，卡片與批次共用）

## Stage 2：訂單批次完成取貨 UI
**Goal**：「處理中」分組（已確認、配送處理中）的訂單卡出現勾選框（只在可完成的卡片）；底部批次列（手機位於底部分頁列上方）顯示「已選 N 筆・待收尾款合計 NT$…」與「批次完成取貨」；確認視窗逐筆明細；依序送出並顯示進度；完成後彙整結果。
**Success Criteria**：其他分頁不出現勾選框；送出中不可重複送出；切換分頁或重新整理後清除選取；失敗項目就地顯示原因。
**Tests**：本機預覽以假 fetch 模擬全部成功、部分失敗（例 FINAL_PAYMENT_REQUIRED）、網路中斷；桌機／手機截圖。
**Status**：Complete（`public/admin-order-batch.js`；每筆送出備註「批次完成取貨」留在狀態歷程）

## Stage 3：規格批次上下架
**Goal**：商品表格每列勾選框＋批次列「上架」「下架」；沿用 `variantPayload` 逐筆 PATCH；成功後更新表格與型錄快取。
**Success Criteria**：商品本身未上架時提示「規格上架但前台仍不顯示」；結果彙整同 Stage 2；手機精簡卡仍維持 44px 觸控目標。
**Tests**：同上。
**Status**：Complete（`public/admin-variant-batch.js`；已是目標狀態的規格不重送）

## Stage 4：驗收與部署
**Goal**：`check:js`、`typecheck`、`npm test`、`git diff --check`、dry-run 通過；正式站以可回復的方式驗證規格批次上下架（上架後再下架回原狀）；批次完成取貨不以真實訂單測試，改在店主實際操作時觀察。
**Status**：Complete（2026-09-28 部署 1ee801e6；店主於正式站實測規格批次上架再下架回原狀正常）

## 風險

- 批次完成會一次送出多則會員 LINE 通知（每筆一則，與單筆相同，最多 10 則），消耗 LINE 額度。
- 批次完成＝逐筆視為尾款已收並入帳點數；誤勾的後果是需逐筆「進入退款處理」，所以確認視窗必須列出尾款。
- 規格 PATCH 會送整筆資料：若他人剛改過同一規格，批次上下架可能覆蓋；沿用單筆既有行為，送出前以最新載入資料為準。
- 店主誤勾：確認視窗逐筆列出訂單、會員與待收尾款，並顯示合計。
