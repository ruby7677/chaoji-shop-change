# 歷史文件

以下文件記錄已完成的改版、審查與 Supabase 優化階段，只供追溯決策與驗證過程。內容中的版本號、檔案行數、流程與待辦**以當時為準**，不代表目前狀態；目前做法以 `AGENTS.md`、`app/README.md`、`app/SUPABASE_SETUP.md`、`app/SECURITY_OPERATIONS_CHECKLIST.md` 與程式碼為準。

| 文件 | 內容 | 狀態 |
| --- | --- | --- |
| `CODEX_UI_UX_HANDOFF.md` | 初版 UI/UX 改版交接（Codex） | 改版已完成並上線 |
| `潮吉好頑-UIUX改版提案-v1.md` | UI/UX 審查與設計方向提案 | 已由後台改版（`ADMIN_REDESIGN_PLAN.md`）與商品頁／首頁輪播（`PRODUCT_SHOWCASE_PLAN.md`）實作 |
| `SUPABASE_USAGE_OPTIMIZATION_PHASE1_3.md` | Supabase 流量優化 Phase 1–10 規劃與結果 | 已完成 |
| `SUPABASE_PHASE8_10_REPORT.md` | Phase 8–10：索引、RLS initplan、撤銷舊 RPC | 已完成，migration 已套用 |
| `SUPABASE_PHASE11_12_REPORT.md` | Phase 11–12 回歸與流量驗收 | 已完成（2026-09-19） |
| `SUPABASE_PHASE13_17_TEST_REPORT.md` | Phase 13–17：商品積點資格與 snapshot 回歸 | 已完成（2026-09-20） |
| `SUPABASE_INDEX_AUDIT.md` | 索引與 Security／Performance Advisor 唯讀審查 | 審查紀錄 |
| `SUPABASE_OPTIMIZATION_REGRESSION.md` | 優化回歸／流量驗收計畫 | 驗收規劃（結果見 Phase 11–17 報告） |
| `MIGRATION_HISTORY_ALIGNMENT_2026-09-24.md` | 正式 DB migration 紀錄對齊檔名版本、結構指紋稽核與新舊版本對照 | 已完成（2026-09-24） |
| `BATCH_OPERATIONS_PLAN.md` | 後台批次完成取貨與規格批次上下架（前端逐筆呼叫既有 API，每批 10 筆） | 已完成並上線（2026-09-28，版本 1ee801e6） |

已結案的功能計畫（`app/ADMIN_REDESIGN_PLAN.md`、`app/PRODUCT_SHOWCASE_PLAN.md`）仍留在 `app/`，因其風險表與部署紀錄仍會被引用。
