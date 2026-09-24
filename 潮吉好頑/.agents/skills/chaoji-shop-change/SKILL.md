---
name: chaoji-shop-change
description: Trace or change 潮吉好頑 cart, order, notification and permission flows across frontend, Worker and SQL. Use when a task crosses these layers.
---

# 潮吉好頑跨層變更

委派方式依根目錄 `AGENTS.md`：Codex 見「主代理與 Luna Worker 分工」，Claude Code 見「Claude Code 對應規則」。

專案根目錄是本技能目錄的 `../../..`，執行程式在其 `app/`。沿用根目錄 `AGENTS.md`；本技能不另建產品規則副本。

## 找到最短影響路徑

依任務選入口，先搜尋函式名稱與呼叫者，再讀相關區段。名稱可能因重構變更；搜尋不到時改查 endpoint 或 DOM selector。

| 任務 | 搜尋入口 | 需要追查的下游 |
| --- | --- | --- |
| 購物車／結帳 | `renderCart`、`openCheckout`、`openSellerDeliveryCheckout`、`submitOrder` | `/api/orders` → `createOrder` → `create_delivery_order` |
| 付款／庫存／狀態 | `submitPayment`、`submitAdminOrderTransition`、`submitAdminOrderFulfillment` | Worker handler → RPC／trigger → 庫存、點數與狀態歷程 |
| LINE 通知 | `notifyOrderEvent`、`buildOrderNotificationMessage` | 路由何時觸發、收件人集合、event key、`notification_deliveries`（claim／complete RPC） |
| 管理頁入口 | `ensureDiscountAdminUI`、`renderAdminData`、`switchAdminTab` | HTML 及 JS 動態插入內容；HTML 無 tab 不代表未實作 |
| LINE／後台權限 | `requireUser`、`requireAdmin`、`syncLineIdentity` | Auth 驗證 → profile 綁定／管理標記 → table/column grants＋RLS |

交易修改前以一句話定義「觸發條件 → 預期結果」，分清前端顯示、Worker 檢查與 SQL 最终限制。只修改需要的層；診斷請求先交付原因，不自動套用修復。

## 專案常見陷阱

- CSS 有多段覆寫與 media queries：先檢查後面的匹配規則，避免持續追加互相抵銷的 override。
- Modal、toast 與動態表單須一起看事件處理；不能只改靜態 HTML。非同步前保存 form／資料，避免完成時引用失效的事件對象。
- 貨幣、庫存、點數不得相信購物車儲存的價格／數量；伺服器與交易函式須重新計算或驗證。
- `service_role` 會繞過 RLS：使用它的每個會員／管理路由，必須先驗證身分、物件歸屬或管理權限。
- `has_table_privilege(...,'UPDATE')=false` 不表示完全不可修改：本專案有欄位級 UPDATE grants，須再查 `has_column_privilege` 或 `information_schema.column_privileges`。
- 型錄底層表（`categories`／`products`／`product_variants`）對 anon／authenticated 只有欄位級 SELECT：`storefront_variants` 或會員 JWT 呼叫的 invoker 函式要用到新欄位時，須在 migration 補該欄位 grant。
- RPC 有多個 overload，SQL 可能被較新 migration 替換；追查完整簽名及實際生效定義，不只看 initial schema。
- 不用正式訂單驗證付款或扣庫存；採隔離測試資料／可回滾測試。真實 LINE 發送會消耗額度並聯絡人員，需有通知測試授權。

## 按風險驗證

UI：正常、空值／長文、提交中、錯誤回饋及受影響斷點。通知：用代表性訂單資料離線檢查文字、收件人分流與重複觸發，不必真的送 LINE。

交易：確認重複提交、錯誤狀態、庫存不足與 rollback；核對訂單、保留量、扣庫存、點數／歷程一致。權限：未登入、一般會員、其他會員物件、管理員與偽造欄位輸入，分別驗證拒絕或允許。依改動挑相關案例，不強制全站重測。

靜態檢查、遠端操作授權與交付依根目錄 `AGENTS.md` 的「驗證與交付」。交接只摘要實際結果與未驗證限制，不附全部工具輸出。
