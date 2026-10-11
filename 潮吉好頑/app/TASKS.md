# 交貨便取代賣貨便：執行進度

設計見 `CVS_DELIVERY_PLAN.md`。

- [x] Stage 1：migration `202610110001_cvs_delivery.sql`（欄位、建單、改狀態、尾款、寄件編號 RPC）
- [x] Stage 1：`tests/db/cvs_delivery.test.sql`、更新 `order_creation.test.sql`、`verify_schema.sql`
- [x] Stage 2：Worker 建單／讀取／後台完成與寄件編號、錯誤訊息、測試
- [x] Stage 3：前台購物車、結帳第二步欄位、第三步運費、訂單卡
- [ ] Stage 4：後台訂單、通知文案、條款／隱私／AGENTS.md
- [ ] Stage 5：gate、Codex 審查、正式 migration（待授權）、部署
