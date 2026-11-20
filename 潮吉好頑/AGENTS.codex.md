# 潮吉好頑：Codex 專用規則

只適用 Codex 環境，是 `AGENTS.md` 的一部分：業務規則、Skill 載入、驗證與部署流程仍以 `AGENTS.md` 為準，本檔只規範 Codex 的工具與分工。Claude Code 不需要讀。

## MCP／本機工具穩定性規則（Codex）

本節只規範 Chat On Steroids／MCP 本機工具的 discovery、連線、session 與 stale catalog 恢復策略，不改變專案業務規則、Skill 流程或驗收標準。

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

Claude Code 的對應方式見 `AGENTS.md` 的「Claude Code 對應規則」。Luna Worker 的模型與推理等級以 `C:\Users\user\.codex\agents\luna-worker.toml` 為準；若內建 `luna_worker` 角色無法套用該設定，改用可指定該設定的 worker，維持下列相同分工與安全邊界。

本專案預設採用「主代理規劃與審核、Luna Worker 執行」的協作方式。只要任務包含程式碼／檔案修改、測試、資料操作或部署，主代理應在理解目標與檢查現況後，將邊界清楚、可獨立驗收的實作工作委派給 `luna_worker`。

- 主代理：理解使用者目標、拆解範圍、定義限制與驗收條件、委派工作、審查 Luna 回報與實際差異、補足整合驗證，最後向使用者交付結果。
- `luna_worker`：理解被委派的範圍、規劃最短可靠路徑、執行修改、完成必要測試與驗證，並回報變更、結果、失敗及剩餘風險。
- 委派時須明確指定工作目錄、檔案／模組歸屬、不可修改項目、驗收條件與是否有部署授權；提醒 Luna 共享同一工作樹，不得回復或覆蓋其他人的未完成修改。
- 主代理不應與 Luna 重複實作同一範圍；可進行唯讀調查、規劃、差異審查及必要的整合修正。若需追加工作，優先將具體回饋再次交給同一 Luna 任務。
- 若 `luna_worker` 不可用、反覆失敗或任務無法安全委派，主代理必須先向使用者說明原因與受影響範圍，才可自行接手實作；不得默默略過委派規則。
- 純說明、狀態查詢、唯讀診斷或只需回答問題的任務不強制啟動子代理。

## Skill 與 MCP 規則的關係

- 新建立的 `luna_worker` 若承接需要載入 `chaoji-shop-change` Skill 的任務，委派內容必須明確要求它自行讀取 `AGENTS.md`、本檔與 `.agents/skills/chaoji-shop-change/SKILL.md`。
- MCP 穩定性規則只處理工具 discovery、連線與重試，不得用來跳過 Skill 規定的檢查。
