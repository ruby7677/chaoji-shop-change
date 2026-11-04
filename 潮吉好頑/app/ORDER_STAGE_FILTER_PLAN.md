# 後台訂單分類改版＋尾款確認通知

## 目標（2026-10-29 使用者決定）

1. 後台訂單分頁改成單排：全部｜待付訂｜待訂金對帳｜待到貨｜已通知待尾款確認｜待出貨／取貨｜已完成｜失效訂單（2026-10-29 最終版）。
   已通知待尾款確認＝交貨便／宅配預購已發到貨通知、尾款未確認（含客人已回報末五碼），徽章只算已回報、等店長對帳的筆數；到店取貨預購到貨（等客人取貨）歸「待出貨／取貨」。
2. 交貨便到貨通知「商品已到貨，請匯尾款」改為「商品已到貨，待付尾款／運費」。
3. 預購交貨便／宅配：管理員勾選「已確認尾款」儲存後，LINE 通知客人、Telegram 通知管理員「尾款確認完成，待出貨後通知」（仿照訂金確認的「已確認訂單付訂完成，待到貨通知」）。

## 分類定義（單一來源：SQL `private.admin_order_stage`，前端 `admin-order-stages.js` 鏡像，測試比對）

| 分類 | 值 | 條件 |
|---|---|---|
| 待付訂 | `pending_payment` | 狀態 pending_payment |
| 待訂金對帳 | `pending_review` | 狀態 pending_review |
| 待到貨 | `awaiting_arrival` | confirmed 且含預購 |
| 已通知待尾款確認 | `awaiting_balance` | partially_ready／ready_for_pickup、含預購、交貨便或宅配、尾款未確認、宅配未「運費已確認且已收齊」；徽章 `balanceReported`＝其中會員已回報末五碼的筆數 |
| 待出貨／取貨 | `ready_to_ship` | 其餘 confirmed／partially_ready／ready_for_pickup：現貨已確認、預購到店取貨到貨、尾款已確認待寄出、賣貨便 |
| 已完成 | `completed` | 狀態 completed |
| 失效訂單 | `cancelled` | cancelled（含逾期自動取消）與舊的 refund_* |

- 「步驟」不新增資料庫狀態：尾款確認後狀態仍是到貨狀態，畫面依 `final_payment_confirmed_at` 顯示「尾款已確認，待出貨」（與「已回報尾款，待確認」相同做法，避免改 enum、轉換規則與庫存觸發器）。

## Stage 1：資料庫
**Goal**：`admin_search_order_ids` 接受新分類值，`admin_dashboard_stats` 回傳各分類筆數。
**Success Criteria**：舊的狀態值仍可用（部署 Worker 前舊前端不壞）；每個分類的允許／排除案例通過。
**Tests**：`tests/db/admin_order_stage.test.sql`；verify_schema 新增檢查。
**Status**：Complete

## Stage 2：尾款確認通知與文案
**Goal**：新事件 `final_payment_confirmed`，只在「這次儲存才確認」時發送，LINE＋Telegram 各一次。
**Success Criteria**：已確認後再儲存不重發；現貨、到店取貨不發；文案改為「待付尾款／運費」。
**Tests**：`tests/worker` 假 fetch 驗證觸發條件、event key、訊息內容。
**Status**：Complete

## Stage 3：後台分頁與前台狀態文字
**Goal**：單排 8 個分頁（窄畫面橫向捲動），徽章顯示待處理筆數；批次完成取貨改掛「待出貨」；前台與後台狀態文字顯示「尾款已確認，待出貨」。
**Success Criteria**：前端分類與 SQL 一致；手機／桌機畫面檢查。
**Tests**：`tests/frontend` 驗證分類函式與分頁。
**Status**：Complete

## 上線順序
先套 migration（舊值相容），再部署 Worker。
