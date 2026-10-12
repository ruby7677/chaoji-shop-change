# 線上一番賞（自製抽獎）規劃書：儲值金 × 選格開抽 × 我的獎品 × 公開驗證

> 建立日期：2026-10-12｜修訂：2026-10-12（納入 Codex 審查，見 §11）
> 參考來源：<https://kujihunter.com/ichibankuji/3392>（含業主提供的「選籤」畫面截圖）、業主自製一番賞海報
> 本文件是規劃，不代表已實作或已部署。實作依 `../AGENTS.md` 的分工、檢查與部署流程；本功能跨前端、Worker、SQL 三層並涉及金額與庫存，**每個 Stage 開始前都要重新讀取 `../.agents/skills/chaoji-shop-change/SKILL.md`**。
> 標記：**【未查證】**＝引用來源未經本專案查證。§10 的營運決策已全部定案（2026-10-12）。

---

## 0. 參考來源拆解

### 0.1 業主海報（實體版玩法）

| 項目 | 內容 |
| --- | --- |
| 版面 | 標題「自製一番賞」、唯一大獎（iPhone 18 Pro Max 256GB，顏色任選）、總抽數 160、單抽 990、遊戲規則、160 格號碼格、右上「中獎號碼」圓框 |
| 玩法 | 號碼格只是標示；每格背後是 1～160 隨機不重複的號碼；開出的號碼等於右上中獎號碼即得大獎。**格號（cell_no）與獎號（prize_number）是兩個欄位** |
| 其餘 | 「其餘可拿小賞 1 個或購買盲盒折抵」 |
| 注意 | 海報號碼格有重複與缺號（79、78、76、75、70、57、52、31 各出現兩次），只作版面參考；線上版由系統產生 1～N 格 |

### 0.2 KUJiHUNTER（線上一番賞）

| 區塊 | 參考站實作 | 本專案取捨 |
| --- | --- | --- |
| 列表卡 | 單價、剩餘抽數「54/60」、A/B 賞剩餘 | 首頁區塊卡片顯示：主圖、單價、剩餘抽數、大獎是否還在 |
| 賞品配率 | A～G 賞色塊＋「剩餘/總數」 | 顯示「大獎 1/1、小賞 剩 x/y」；資料模型支援分級，日後可開 A～G |
| 選籤 | 「第 N 張」格子；已開格子對所有人顯示結果，未開顯示 Logo | 已開格子對所有人顯示「開出號碼＋小賞名稱」，不顯示是誰抽的 |
| 天選 | 隨機幫你挑未開的格子 | 做：輸入張數，伺服器從未開格子隨機挑 |
| 開抽／包套 | 「開抽」送出所選格子；「包套」剩餘全買打折 | 做「開抽」；包套暫不做 |
| 排隊 | 人多時須排隊 | 不做排隊；以資料庫鎖保證同一格只賣一次，衝突時整批失敗並提示重選 |

---

## 1. 已確認決策（業主 2026-10-12）

| 項目 | 決策 |
| --- | --- |
| 小賞 | **每抽保證有**；多種隨機；對應現有商品規格並扣庫存 |
| 小賞池 | 開賣時固定：管理員設定每款小賞數量，總數＝總抽數 − 1；大獎得主不另拿小賞 |
| 規則文案 | 「每抽必中獎品；抽中大獎者獲得唯一大獎，其餘獎號各得小賞一份」（避免誤解大獎得主另有小賞） |
| 小賞或折抵券 | 在「我的獎品」由客人二選一；折抵券面額每張活動自訂，只能用於「盲盒」分類商品；選券後該小賞庫存放回 |
| 大獎抽走後 | **每張活動各自設定**（Q1 選 c，2026-10-12）：`end_on_grand=true` 立即結束、剩餘格子不賣；`false` 繼續販售到售完。後台建立活動時必須明確選擇，不給預設值；開賣後鎖定並納入承諾值。平均收益：設為結束時，每次只買一格平均售出 (N+1)/2 抽 |
| 大獎抽出後續賣 | `end_on_grand=false` 且大獎已開出時，活動頁、格子區與確認視窗都要明顯標示「大獎已被抽走，剩餘格子皆為小賞」 |
| 一次多格 | 同一筆交易；大獎在其中時整批照樣成立並扣款；`end_on_grand=true` 時交易提交後才結束這張；**確認視窗必須事先揭露此規則** |
| 對應表 | 管理員後台看不到；開賣時公布承諾值，結束後公開種子供驗證 |
| 多張同時 | 可同時開多張；單一會員無購買上限；一次可抽格數只受儲值金餘額限制 |
| 儲值金 | 獨立帳本，不與回饋點數共用；1 元＝1 元、永不到期、退款由管理員手動處理（退款條件受 §1.1 法規約束）；用儲值金抽獎不累積回饋點；回饋點數不能用來抽 |
| 加值 | 第一版：客人匯款後聯繫客服，管理員在後台手動加值（日後改為客人線上回報匯款，見 §9） |
| 取消／到期 | 各情境處理見 §4.4；店家主動取消販售中的活動**不補償**已購買者（Q4，2026-10-12），已抽獎品照常交付 |
| 兌獎 | 先放進「我的獎品」，累積後一起申請出貨 |
| 出貨運費 | 7-11 店到店：申請時扣儲值金，金額為 `private.cvs_shipping_fee(0)`（獎品小計以 0 計，目前 NT$60）；到店取貨免運；**宅配**（Q3 選 a，2026-10-12）：申請出貨 → 管理員報價 → 會員確認並扣儲值金 → 出貨，不在到貨後扣款 |
| 大獎 | 綁 1 到多個型錄規格（例如四個顏色），兌獎時客人選一個 |
| 大獎顏色 | Q2 選 b（2026-10-12）：開賣時只保留一台（管理員指定的「保底顏色」規格）；兌獎時只能選**兌獎當下有庫存**的顏色，保底顏色因有保留必定可選；改選其他顏色時扣該規格並釋放保底保留。海報與活動頁不得寫無條件「顏色任選」，改寫「顏色依兌獎時庫存選擇」 |
| 小賞扣庫存時機 | 開賣時保留，抽中時扣庫存（儲值金扣款＝已付款，符合「確認款項才扣庫存」） |
| 配率顯示 | 做；包套暫不做 |

### 1.1 未確認（不可視為已解決；正式收取真實儲值前必須完成，見 Stage 0）

- **賭博／彩券**：付費隨機抽獎是否涉及刑法賭博或未經允准發行彩票等規定；「每抽保證有實體小賞」是常見前提，但小賞價值與單抽價差多少才合理，**未確認**，需業主洽律師。（Codex 提及刑法第 266、268、269 條【未查證】）
- **儲值金規範**：預付型儲值是否落入商品（服務）禮券的履約保障、退款程序等規範，**未確認**。
- **LINE 平台政策**：官方帳號／LIFF 對抽獎、賭博類服務的限制，**未確認**。（Codex 提及 2026-10-01 修訂的台灣官方帳號操作準則【未查證】）
- **稅務**：大獎是否屬「機會中獎」而須扣繳、申報與蒐集得主身分資料，付費取得隨機商品的稅務分類，**未確認**。（Codex 提出【未查證】）
- **廣告揭露**：公平會對網路抽獎廣告的獎項、機率、參加條件與限制事項揭露要求，**未確認**。（Codex 提出【未查證】）
- **定型化條款**：海報「本店保有最終解釋權」可能違反消保法對定型化契約的限制，建議線上版不使用，**未確認**。
- 對客人的公平性說法只能寫「開賣後結果已鎖定、結束後可驗證」，不能寫「店家也不知道答案」或「店家無法挑選結果」（見 §4.3 能力邊界）。

---

## 2. 專案現況與關鍵限制（已核對程式碼）

| 項目 | 現況（已核對） | 對本功能的影響 |
| --- | --- | --- |
| 回饋點數 | `public.point_ledger`＋`point_settings.point_value`（每點折抵金額可調） | 儲值金另開帳本，不能沿用 |
| 管理員調點 | `admin_adjust_member_points` 已 `revoke … from public, anon, authenticated` 並只 grant `service_role`（`202609220005`） | 新的錢包／抽獎 RPC 比照此權限模式 |
| 庫存保留 | `inventory_reservations(variant_id, order_id 可為 null, quantity check > 0, expires_at, released_at)`；可售量＝`stock_on_hand − 未釋放且未到期的保留` | Stage 1 已決定共用此表（新增 `lottery_id`），所有可售量計算自動扣抽獎保留；審查結果見 §8 Stage 1 |
| 優惠券 | `coupons`＋`coupon_products`＋`coupon_members`，**不能綁分類**；`orders.coupon_id` 單一欄位（一張訂單一張券）；折抵額＝`least(券面額, 適用商品小計)` | 盲盒券需新增 `coupon_categories` 並同步修改 `create_delivery_order` 與 `preview_checkout_coupon` |
| 店到店運費 | `private.cvs_shipping_fee(p_subtotal integer)`，含滿額免運門檻 | 獎品出貨以小計 0 呼叫 |
| 訂單 | `orders`（status enum 含 pending_payment … completed）＋`order_items` | 獎品出貨建議不併入訂單（§4.5） |
| 隨機與雜湊 | 初始 schema 已使用 pgcrypto；排程用 pg_cron | 開賣時產生種子與承諾值；到期自動結束用 pg_cron |
| 通知 | `notification_deliveries`（claim／complete RPC）、LINE 文案在 `src/line-notification-messages.ts` | 大獎通知沿用，加新的 event key；交易內只寫待發事件，提交後才寄送 |
| 頁面路由 | SPA fallback；`run_worker_first` 列出 `/products/*`、`/orders` 等 | 新增 `/lottery`、`/lottery/*`、`/prizes` 時同時加入 `run_worker_first` |
| 登入回跳／限流 | `captureAuthReturn()`（`public/auth-return-state.js`）；`enforceRateLimit()`（`src/http.ts`） | 沿用 |
| CSP | 無 `unsafe-inline`；圖片只能同源或 `img.767780.xyz` | 刮開動畫用 class＋CSS |
| 檔案大小 | 單檔 500 行上限 | 全部用新模組實作，入口檔只加 import 與接線 |

---

## 3. 資料層設計（Supabase）

### 3.1 儲值金（雙層：餘額帳戶＋不可變帳本）

```
public.wallet_accounts
  member_id uuid pk → profiles
  balance integer not null default 0 check (balance >= 0)
  updated_at timestamptz

public.wallet_ledger
  id uuid pk
  member_id uuid → profiles
  kind text check in ('topup','draw','shipping','refund','adjust','reversal')
  amount integer check (amount <> 0)        -- 正數入帳、負數扣款
  balance_after integer not null
  lottery_id / draw_id / shipment_id uuid null
  reversal_of uuid null → wallet_ledger      -- 沖正對象
  request_id uuid unique null               -- 管理員操作防重送
  transfer_ref text null                    -- 匯款參照（日期／末五碼等，選填）
  reason text not null
  actor_id uuid null
  created_at timestamptz
```

- 每次異動在同一交易內：`select … from wallet_accounts where member_id = $1 for update` → 更新 `balance` → 寫 `wallet_ledger`。`check (balance >= 0)` 讓資料庫保證**餘額永遠不會小於 0**。
- 帳本不可修改：對所有 API 角色不授予 update／delete，另加 trigger 拒絕 update／delete；錯帳以 `reversal` 紀錄沖正，不改歷史。
- 管理員加值 `admin_adjust_wallet(actor, member, amount, reason, request_id, transfer_ref)`：同一 `request_id` 重送回傳原結果；寫既有 `audit_logs`（不另建 wallet_audit）。
- 一致性檢查：測試與後台健康檢查比對 `wallet_accounts.balance = sum(wallet_ledger.amount)`。
- RLS：會員只能 select 自己的帳戶與帳本；寫入只經 RPC。
- **RPC 執行權限**：本規劃所有帶身分參數的函式（`admin_adjust_wallet`、`admin_open_lottery`、`lottery_draw`、`member_prize_*` 等）一律 `revoke … from public, anon, authenticated`，只 grant `service_role`，由 Worker 驗證身分後呼叫。

### 3.2 抽獎活動

```
public.lotteries
  id, title, subtitle, description（規則說明）, cover_image_path
  total_cells integer (2..1000)
  price integer > 0
  winning_number integer (1..total_cells)
  end_on_grand boolean not null          -- 大獎開出即結束；建立時必填、無預設值
  grand_reserved_variant_id uuid not null -- 保底顏色；必須是 lottery_grand_options 之一
  grand_drawn_at timestamptz null         -- 大獎開出時間（續賣時用於前台標示）
  status text: 'draft' | 'on_sale' | 'closed' | 'cancelled'
  closed_reason text null: 'grand_prize_drawn' | 'sold_out' | 'expired' | 'cancelled'
  starts_at, ends_at timestamptz null
  coupon_amount integer null              -- 盲盒折抵券面額；null＝不提供換券
  coupon_valid_days integer default 90
  algorithm_version integer default 1
  manifest text null                      -- 開賣時寫入：§4.3 的規範化活動資料
  commitment text null                    -- sha256(manifest) 的 hex
  revealed_seed text null                 -- 結束後才寫入
  created_by, created_at, updated_at, opened_at, closed_at

public.lottery_grand_options     -- 大獎可選規格（顏色）
  lottery_id, variant_id, display_order
public.lottery_small_prizes      -- 小賞池；開賣 RPC 檢查 sum(quantity) = total_cells − 1
  lottery_id, variant_id, quantity > 0
private.lottery_secrets          -- anon／authenticated／後台 API 都不可讀
  lottery_id pk, seed bytea
private.lottery_cells            -- 格子對應表
  lottery_id, cell_no (1..N), prize_number (1..N), small_prize_variant_id null（大獎格為 null）
  draw_id null, drawn_at null
  unique (lottery_id, cell_no), unique (lottery_id, prize_number)
public.lottery_draws             -- 一次開抽（一筆交易）
  id, lottery_id, member_id, request_id uuid unique, cell_count, amount, created_at
```

- 草稿可編輯；**開賣後**標題以外的規則欄位全部鎖定，由 trigger 拒絕修改；開賣後不可重新產生種子、不可退回草稿。
- 已開格子對外只經 `lottery_public_board(lottery_id)` 輸出：`cell_no`、`prize_number`、`small_prize_variant_id`、小賞名稱、是否大獎；**不輸出 member_id**；未開格子只輸出 `cell_no`。

### 3.3 我的獎品

```
public.member_prizes
  id, member_id, lottery_id, draw_id, cell_no, prize_number
  unique (lottery_id, cell_no)       -- 防重複發獎的最後一道保護
  tier text: 'grand' | 'small'
  variant_id null              -- 小賞：抽中時即決定；大獎：兌獎選色後寫入
  status text: 'held' | 'exchanged_coupon' | 'requested' | 'shipped' | 'void'
  coupon_id null, shipment_id null
  created_at, updated_at
```

### 3.4 盲盒折抵券

- 新增 `coupon_categories(coupon_id, category_id)`：券可綁分類，結帳時商品屬於任一綁定分類即可折抵（折抵額仍為 `least(券面額, 適用商品小計)`）。
- 換券時建立一張只發給該會員的券（`coupon_members`＋`per_member_limit=1`＋`total_usage_limit=1`），代碼由系統產生，有效期＝`coupon_valid_days`。
- 「盲盒分類」存於 `private.lottery_settings.blind_box_category_id`，後台可選。

---

## 4. 核心交易與公平性

### 4.1 開賣 `admin_open_lottery(actor, lottery_id)`

1. 檢查：草稿狀態、小賞總數＝N−1、大獎至少一個規格、保底顏色屬於大獎選項且可售量 ≥ 1、各小賞規格「可售量 ≥ 設定數量」（同一規格同時是小賞與保底顏色時合併計算）。
2. `seed := gen_random_bytes(32)` 存 `private.lottery_secrets`。
3. 依 §4.3 產生 `lottery_cells`（號碼排列＋小賞分配）。
4. 為每款小賞與保底顏色（1 台）建立庫存保留（共用 `inventory_reservations`，新增 `lottery_id` 並加約束 `(order_id is null) <> (lottery_id is null)`，見 Stage 1 ②）。保底保留在大獎開出後轉為該大獎獎品所有，直到兌獎選色或出貨才處理；活動結束時不釋放未兌換大獎的保底保留。
5. 寫入 `manifest`、`commitment`、`status='on_sale'`、`opened_at`；寫 `audit_logs`（含發布時間）。

### 4.2 開抽 `lottery_draw(member_id, lottery_id, cells int[], request_id)`

全部在同一個交易內；**鎖定順序固定為「活動 → 會員錢包」**（加值、運費只鎖錢包），避免死結：

1. 若 `request_id` 已存在 → 直接回傳上次結果（防連點、網路重送）。
2. `select … for update` 鎖住這張活動；必須 `on_sale` 且在販售時間內。
3. 格子去重、檢查都在 1..N，且 `draw_id is null`；任一格已被抽走 → **整批失敗**，回傳被搶走的格子，不扣款。
4. `for update` 鎖會員錢包，餘額 ≥ 單價 × 格數，否則拒絕（同會員同時在 A、B 兩張開抽也因此序列化）。
5. 寫 `lottery_draws`；扣 `wallet_accounts` 並寫 `wallet_ledger(kind='draw')`。
6. 標記格子 `draw_id／drawn_at`；為每格寫 `member_prizes`。
7. 小賞：對應保留量 −1（`quantity` 有 `check (> 0)`，剩 1 時改設 `released_at`，不可更新成 0）、`stock_on_hand` −1，寫 `inventory_movements`（原因：抽獎小賞）。
8. 若這批含中獎號碼 → 寫 `grand_drawn_at`、寫入大獎待發通知；`end_on_grand=true` 時再 `status='closed', closed_reason='grand_prize_drawn'`、釋放剩餘小賞保留、公開種子；`false` 時繼續販售。全部抽完 → `closed_reason='sold_out'`，公開種子。
9. 提交後回傳每格結果；前端播刮開動畫（動畫只是效果，結果在交易提交時已成立；關閉網頁後仍可在「我的獎品」查到）。

**履約原則**：大獎即使在第 1 抽開出，店家也必須履約；不得以未回本為由取消、重抽或修改對應表。

### 4.3 對應表演算法與承諾（公開，供客人驗證）

```
號碼排列：把 1..N 依 sha256(seed ‖ "number:" ‖ n) 由小到大排序，第 k 個放到第 k 格
小賞分配：把小賞池展開成 N−1 個項目（依 variant_id 字典序、各重複 quantity 次），
          依 sha256(seed ‖ "prize:" ‖ 項目序號) 排序，依序分給「非中獎號碼」的格子（格號由小到大）
```

位元組編碼（SQL 與瀏覽器 JS 必須逐位元一致，Stage 5 以固定測試向量對照）：

- `seed`：原始 32 bytes；公開時以小寫 hex 表示，驗證端先 hex 解碼回 bytes。
- 前綴與數字：UTF-8 字串，數字用十進位不補零，例如 `"number:" ‖ "17"`；`‖` 為位元組串接。
- 排序鍵：digest 的小寫 hex 字串由小到大；相同時以 n（或項目序號）由小到大決定。
- 小賞池展開：`variant_id` 以小寫含連字號的 uuid 字串字典序排序；項目序號從 1 起算。
- 「非中獎號碼的格子」＝`prize_number ≠ winning_number` 的格子，依格號由小到大。

**承諾範圍（manifest）**：開賣時把整份活動規則規範化後雜湊，不只雜湊種子。`manifest` 為 UTF-8、無空白、key 依下列順序的 JSON：

```
{"v":<algorithm_version>,"lottery_id":"<小寫uuid>","total_cells":N,"price":P,"winning_number":W,
 "end_on_grand":true|false,"grand_options":["<uuid>",…依字典序],
 "small_prizes":[["<uuid>",數量],…依uuid字典序],"seed_sha256":"<小寫hex>"}
```

`commitment = sha256(manifest)` 的小寫 hex。開賣時公開 `manifest` 與 `commitment`；結束後公開 `revealed_seed`。驗證頁在瀏覽器用 Web Crypto 重算：①`sha256(manifest) == commitment`；②`sha256(seed) == seed_sha256`；③重算出的每格號碼／小賞與實際開出的完全一致。另提供可獨立執行的驗證腳本與固定測試向量。

**能力邊界**（對外說明不得超出）：

- 能證明：開賣後對應表、中獎號碼、小賞池、單價、結束規則沒有被替換。
- 不能證明：店家技術上沒看過（資料庫擁有者與 service_role 讀得到 `private` schema）；也不能排除資料庫擁有者在交易內試開後回滾、反覆挑選有利種子（稽核紀錄看不到回滾的嘗試）。已以「開賣後不可重新產生種子、開賣寫 audit log」限制一般操作，但不宣稱能防止上述行為。

### 4.4 結束、取消與退款情境

| 情境 | 處理 |
| --- | --- |
| 格子尚未販售 | 沒有交易，不需退款；活動結束時關閉 |
| 已付款且正常開出獎品 | 依事先揭露的活動條款交付獎品，不退抽獎款 |
| 扣款成功但未產生獎品 | 交易設計上不會發生（同一交易）；若因系統錯誤發生，管理員以 `reversal` 沖正並記錄原因 |
| 到期（大獎未抽出，或續賣中已抽出） | pg_cron 每 5 分鐘將 `ends_at` 已過的活動改 `closed / expired`，已抽獎品保留，釋放未售出小賞的保留；大獎未抽出時一併釋放保底保留，已抽出則保底保留留給得主；公開種子 |
| 店家主動取消販售中的活動 | 只允許 `on_sale` 時操作；釋放未售出小賞的保留（保底保留比照到期規則）、公開種子；已抽獎品不受影響；**不補償已購買者**（Q4）；活動條款須事先揭露店家可取消的情形與不補償規則（受 §1.1 法規確認約束） |
| 會員要求退還未使用的儲值餘額 | 依儲值契約與 §1.1 法規確認結果處理；系統以 `refund` 扣減餘額並記錄，不由管理員任意決定規則 |

- 「不退已完成抽獎的款項」與「不提供任何退款」是不同規則，條款中分開寫。
- 草稿可刪除；開賣後不可刪除。

### 4.5 我的獎品與出貨

| 操作 | 規則 |
| --- | --- |
| 小賞換折抵券 | 單一 RPC 內完成：建立券、獎品改 `exchanged_coupon`、該規格 `stock_on_hand` +1（寫 movement），一起成功或一起失敗；只限 `held` 的小賞且該活動有 `coupon_amount` |
| 大獎選色 | 只列出當下可售量 ≥ 1 的大獎規格＋保底顏色；選保底顏色 → 保底保留轉為扣庫存；選其他顏色 → 扣該規格庫存並釋放保底保留；寫 `variant_id`，不可重複選 |
| 申請出貨 | 勾選多個 `held` 獎品（大獎須先選色）＋選配送方式 → 建立出貨單 → 獎品改 `requested` |
| 取消申請 | 出貨單尚未付款（`quoted` 前或報價後未確認）時會員可取消，獎品回到 `held` |

出貨單狀態：

| 配送方式 | 流程 |
| --- | --- |
| 7-11 店到店 | 申請時同一交易扣 `cvs_shipping_fee(0)` → `paid` → 管理員出貨 `shipped`；餘額不足時申請被拒 |
| 宅配 | 申請 → `awaiting_quote` → 管理員填運費 `quoted`（通知會員）→ 會員確認，同一交易扣儲值金 → `paid` → 管理員出貨 `shipped`；餘額不足時確認被拒，出貨單停在 `quoted` |
| 到店取貨 | 申請 → `paid`（運費 0）→ 取貨後 `shipped` |

**出貨模型（建議，Stage 1 審查後定案）**：採獨立的 `prize_shipments`（配送方式、收件資訊、門市、運費、狀態、寄件編號、管理員備註）＋`prize_shipment_items`（member_prize_id），重用既有配送欄位格式、`cvs_shipping_fee` 與 7-11 門市資料，但**不建立 `orders`**，避免被付款期限 cron、折扣、點數入帳、建單保留與扣庫存流程誤處理。後台新增「獎品出貨」列表。若 Stage 1 審查顯示沿用 `orders` 的成本更低，在此記錄理由後再改。

---

## 5. Worker API（新模組，皆 < 500 行）

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| GET | `/api/lotteries` | 公開 | 販售中＋最近結束的活動列表 |
| GET | `/api/lotteries/:id` | 公開 | 活動詳情、配率、已開格子、`manifest`／`commitment`；結束後含 `revealed_seed` |
| POST | `/api/lotteries/:id/draw` | 會員 | body：`{ cells: number[], requestId }` 或 `{ random: n, requestId }`（天選，由伺服器挑格） |
| GET | `/api/lotteries/draws/:requestId` | 會員 | 以請求編號查詢是否已成交（逾時後先查再決定是否重送） |
| GET | `/api/member/wallet` | 會員 | 餘額＋最近紀錄 |
| GET | `/api/member/prizes` | 會員 | 我的獎品 |
| POST | `/api/member/prizes/exchange` | 會員 | 小賞換折抵券 |
| POST | `/api/member/prizes/grand-option` | 會員 | 大獎選色 |
| POST | `/api/member/prizes/shipments` | 會員 | 申請出貨 |
| POST | `/api/member/prizes/shipments/:id/confirm` | 會員 | 確認宅配運費報價並扣儲值金 |
| POST | `/api/member/prizes/shipments/:id/cancel` | 會員 | 取消尚未付款的出貨申請 |
| GET／POST／PUT | `/api/admin/lotteries…` | 管理員 | 草稿 CRUD、開賣、取消、查詢抽獎紀錄（不含未開格子） |
| GET／PUT | `/api/admin/prize-shipments…` | 管理員 | 獎品出貨列表、宅配運費報價、出貨狀態、寄件編號 |
| POST | `/api/admin/members/:id/wallet` | 管理員 | 加值／退款／調整，body：`{ kind, amount, reason, requestId, transferRef? }` |
| POST | `/api/admin/wallet-entries/:id/reverse` | 管理員 | 沖正一筆加值／退款／調整，body：`{ reason, requestId }` |
| PUT | `/api/admin/lottery-settings` | 管理員 | 盲盒分類 |

- 新模組：`src/lottery-public.ts`、`src/lottery-member.ts`、`src/lottery-admin.ts`、`src/wallet.ts`、`src/member-prizes.ts`、`src/prize-shipments.ts`；`index.ts` 只加路由。
- 開抽路由用 `enforceRateLimit()`；金額、單價一律由 RPC 從資料庫讀，不信任前端。
- `wrangler.jsonc` 的 `run_worker_first` 加 `/lottery`、`/lottery/*`、`/prizes`；`canonical-host` 測試補對應案例。

---

## 6. 前端設計

### 6.1 新增檔案

| 檔案 | 用途 |
| --- | --- |
| `public/lottery-home.js`＋`lottery-home.css` | 首頁「線上一番賞」區塊卡片列表 |
| `public/lottery-page.js` | `/lottery/:id` 頁：海報區、配率、中獎號碼、規則、承諾值 |
| `public/lottery-board.js`＋`lottery-board.css` | 選格網格（手機 5 欄、平板 10 欄、桌機 20 欄）、已開格子、多選、天選 |
| `public/lottery-draw.js` | 確認視窗、送出、逾時查詢、衝突處理 |
| `public/lottery-reveal.js`＋`lottery-reveal.css` | 刮開動畫（可略過；`prefers-reduced-motion` 時直接顯示結果） |
| `public/lottery-verify.js` | 結束後的驗證區：瀏覽器重算並顯示「驗證通過／不符」 |
| `public/member-wallet.js` | 會員區「儲值金」餘額與紀錄 |
| `public/member-prizes.js`＋`member-prizes.css` | 我的獎品：換券、大獎選色、勾選申請出貨 |
| `public/admin-lottery-panel.js`＋`admin-lottery.css` | 後台「抽獎」分頁 |
| `public/admin-prize-shipments.js` | 後台「獎品出貨」列表 |
| `public/admin-wallet.js` | 後台會員面板的「儲值金加值／調整／沖正」 |

新增前台 CSS 依 `scripts/build-css.mjs` 加入對應合併段；後台 CSS 不併入。

### 6.2 互動規則

- 未登入點格子 → 走現有 LINE 登入，登入後回到原活動頁（`captureAuthReturn()`）。
- 已選格子以外框＋勾選標示；底部固定列顯示「已選 n 格 · NT$xxx · 餘額 NT$yyy」與「開抽」按鈕。
- **確認視窗必須寫明**：「同一次開抽的格子即使包含大獎，也會全部成立並扣款。」並依活動設定加上「大獎開出後本活動立即結束」或「大獎開出後仍繼續販售至售完」。
- `end_on_grand=false` 且大獎已開出：活動卡、活動頁頂端、格子區與確認視窗顯示「大獎已被抽走，剩餘格子皆為小賞」，配率顯示「大獎 0/1」。
- 大獎顏色文案寫「顏色依兌獎時庫存選擇」，不寫無條件「顏色任選」。
- 餘額不足時按鈕停用，提示「請先儲值，聯繫客服 @078isxfl」。
- 送出時產生 `requestId`（`crypto.randomUUID()`），送出中按鈕鎖定；逾時或網路錯誤時先以 `GET /api/lotteries/draws/:requestId` 查詢，未成交才用同一 `requestId` 重送。
- 格子被別人搶走 → toast 列出格號、刷新盤面、保留其餘選取。購買能否成立一律以伺服器檢查為準，盤面只是顯示。
- 頁面在前景時每 15 秒刷新盤面；切回分頁立即刷新。Stage 5 量測熱門時段的查詢負載，必要時改為版本號比對或推播。
- 結束的活動：顯示所有已開格子、結束原因與驗證區。
- 手機輸入字體 ≥ 16px；彈窗右上關閉鈕捲動時可見；所有時間以台灣時間顯示。

---

## 7. 通知

| 事件 | 會員 LINE | 管理員 Telegram |
| --- | --- | --- |
| 抽中大獎 | 恭喜＋前往我的獎品選色 | 活動名稱、會員、格號 |
| 管理員加值 | 已入帳金額與餘額 | — |
| 獎品申請出貨 | — | 會員、品項、配送方式 |
| 宅配運費已報價 | 運費金額＋前往我的獎品確認（Q3 流程需要，否則會員不知道要確認） | — |
| 活動結束（大獎抽出／售完／到期） | — | 活動名稱與原因 |

小賞不發通知。交易內只寫待發事件，提交後由既有 `notification_deliveries` 的 claim／complete 與 event key 寄送與防重複。

---

## 8. 分階段實作

**閘門**：Stage 0 的營運決策 Q1～Q9 已於 2026-10-12 全部決定；§1.1 法規確認須在 Stage 7 開放真實儲值前完成，建議在投入 Stage 3 前先取得初步意見，避免玩法改變後重做資料層。

### Stage 0：業主決策與法規確認（業主負責）
**Goal**：§10 營運決策定案（2026-10-12 已完成）；§1.1 取得專業意見。
**Success Criteria**：§10 每題有決定並回填 §1；§1.1 每項有結論或明確的上線限制。
**Tests**：無（文件檢查）。
**Status**：In Progress（Q1～Q9 已決定；§1.1 法規確認未完成）

### Stage 1：既有系統基線審查（唯讀）
**Goal**：用實際 SQL／RPC／Worker 原始碼確認整合點，決定庫存保留與出貨模型。
**Success Criteria**：在本節記錄結論——①所有讀寫 `inventory_reservations` 的函式、cron、view、後台畫面在 `order_id is null` 時的行為；②共用或另建保留表；③出貨沿用 `orders` 或 `prize_shipments`；④`coupon_categories` 需修改的 SQL 與 Worker 位置；⑤`audit_logs` 寫入方式；⑥CI database job 可用。
**Tests**：無程式變更；基線 `npm run check:js`、`npm run typecheck`、`npm test`（370／370）於 `feat/lottery` 起點全部通過（2026-10-12）。
**Status**：Complete（2026-10-12）

**Stage 1 審查結論**（方法：以腳本取出每個函式 overload 在 migrations 中最後一次的定義，再逐一閱讀；`create_pending_order`、`create_discounted_order` 已於 `202609250003` drop，不計）：

① `inventory_reservations` 的實際使用者：

| 物件（生效定義所在 migration） | 行為 | `order_id is null`（抽獎保留）時 |
| --- | --- | --- |
| `private.storefront_available_stock`（`202609140002`）→ `storefront_variants` view | 依 `variant_id` 加總未釋放且未到期的保留 | 正確計入，前台可售量自動扣掉抽獎保留 ✅ |
| `create_delivery_order`（`202610110001`） | 建單時同樣依 `variant_id` 加總保留檢查庫存；插入保留時帶 `order_id` | 正確計入，不會超賣 ✅ |
| `admin_adjust_inventory`（`202609220005`） | 調整後庫存不得低於總保留量（`BELOW_RESERVED_STOCK`） | 管理員不能把庫存調到低於抽獎保留，符合需求 ✅ |
| `cancel_expired_orders`（`202609140001`） | 只更新 `where order_id = v_order.id` | 不影響 ✅ |
| `sync_order_reservation_lifecycle` 觸發器（`202609140001`） | INSERT 時以 `new.order_id` 查訂單覆寫 `expires_at`；訂單狀態變更時只更新該訂單的保留 | 查無訂單時保留原值，不影響 ✅ |
| `backup_snapshot`（`202610100001`） | 整表 `to_jsonb` | 新欄位自動納入備份 ✅ |
| RLS | `deny api roles`（`202609140003`） | 抽獎保留同樣不對 API 角色開放 ✅ |
| Worker／前端 | 沒有直接讀寫此表；後台庫存與低庫存（`low_stock_variants`）只看 `stock_on_hand` | 後台顯示的是實際庫存，不扣保留；與現有訂單保留行為一致（見「發現」） |

② **決定：共用 `inventory_reservations`**，新增 `lottery_id uuid null references lotteries(id)` 與約束 `(order_id is null) <> (lottery_id is null)`，抽獎保留 `expires_at='infinity'`。理由：所有可售量計算已依 `variant_id` 加總，另建表必須修改 `storefront_available_stock`、`create_delivery_order`、`admin_adjust_inventory` 三處交易函式，風險較高。

③ **`prize_shipments` 無障礙**（Q7 維持）：可沿用訂單已有的欄位格式與約束——`delivery_method`（`store_pickup`／`home_delivery`／`cvs_delivery`）、`shipping_recipient_name`、`shipping_phone`、`shipping_address`、`pickup_store_city／district／name／code`（店號 6 碼）、`shipment_tracking_number`（`^[A-Za-z0-9-]{1,40}$`）；運費用 `private.cvs_shipping_fee(0)`。前端 `public/cvs-delivery.js`（運費常數、門市文字）與 `public/checkout-cvs-store.js` 的 `cvsStoreProblem()`（門市驗證）可重用；`ensureCvsStoreFields()` 綁定結帳表單 DOM，獎品出貨表單需另寫或先抽出共用元件（Stage 6 決定）。

④ **`coupon_categories` 修改點**：優惠券適用商品判斷目前是「未設定任何 `coupon_products` → 全部商品適用；否則商品須在清單內」，位於 `create_delivery_order`（`202610110001`，第 142–143 行附近）與 `preview_checkout_coupon`（`202610110002`）。新規則：未設定任何商品**且**未設定任何分類 → 全部適用；否則商品在清單內**或**商品 `category_id` 在分類清單內。兩支函式須以新 migration 寫出完整 `create or replace`。Worker `src/coupon-preview.ts` 只轉呼叫 RPC，不需修改。另需確認 `member_available_coupons()`（會員「我的優惠券」）與後台優惠券列表如何顯示分類券（Stage 6）。

⑤ **稽核與不可變帳本做法**：既有 `public.append_audit_log(actor, action, resource, target, before, after)`，管理 RPC 在同一交易內呼叫（`202609220005`）；`audit_logs.actor_id` 為 not null，系統排程（到期結束）不寫 audit log，改記在活動本身的 `closed_at`／`closed_reason`。`audit_logs` 已有不可變做法：revoke update／delete／truncate（含 service_role）＋`before update or delete` 觸發器拋 `AUDIT_LOG_IMMUTABLE`（`202609220004`）——`wallet_ledger` 照此實作。

⑥ **測試環境**：本機沒有 PostgreSQL（無 `psql`／`pg_ctl`），`npm run test:db` 無法在本機執行；以 GitHub Actions `CI` 的 `database` job（PostgreSQL 16＋pg_cron，push 到任何分支、路徑含 `潮吉好頑/app/**` 即觸發）為準，並可下載 `effective-db-functions` artifact 核對生效函式定義。`checks` job 跑 typecheck、check:js、npm test、wrangler dry-run。

### Stage 2：儲值金帳戶、帳本與後台加值
**Goal**：會員有獨立儲值金，管理員可加值／調整／沖正。
**Success Criteria**：後台加值後會員看到餘額與紀錄；餘額不可能為負；同一 `requestId` 不重複入帳；帳本不可修改；每筆有 audit log；`balance = sum(ledger)`。
**Tests**：`tests/db/wallet.test.sql`（加值、扣到負數被拒、重送不重複入帳、沖正、update／delete 帳本被拒、一般會員不能寫入、不能讀別人的帳、authenticated 直接呼叫 RPC 被拒）；`tests/worker` 加值路由權限（未登入 401、會員 403、管理員 200）。
**Status**：Complete（2026-10-12，未部署、未套用正式 DB）

**Stage 2 實作紀錄**：
- migration `202610121001_member_wallet.sql`：`wallet_accounts`／`wallet_ledger`、`admin_adjust_wallet`（kind 限 `topup` 正數／`refund` 負數／`adjust` 非 0，單筆上限 1,000,000）、`admin_reverse_wallet_entry`（只沖正上述三種；抽獎與運費的沖正留給 Stage 3／6）、`member_wallet_balance()`；`backup_snapshot()` 加入兩張表。會員只看得到 `id, kind, amount, balance_after, reason, created_at`，**原因文字會員看得到**，後台欄位已標示。
- Worker `src/wallet.ts`；沖正另開 `/api/admin/wallet-entries/:id/reverse`（§5），不和加值共用同一路由。
- 前台 `member-wallet.js` 在**開啟會員資料視窗時**才讀取（60 秒快取），不增加每次開機的請求；從未有紀錄且餘額 0 的會員不顯示。後台 `admin-wallet.js`＋`admin-wallet.css` 在會員卡內，沖正原因用就地表單（不用 `window.prompt`）。
- §7「管理員加值 → 會員 LINE 通知」依 Stage 7 Goal 與其他通知一起實作，Stage 2 不發通知。

### Stage 3：抽獎資料層與交易 RPC
**Goal**：建立活動、開賣、開抽、結束／取消全部在 SQL 完成且可驗證。
**Success Criteria**：§4.1～4.4 行為成立；對應表與種子對 anon／authenticated／後台 API 不可讀；保留量正確計入前台可售量。
**Tests**：`tests/db/lottery.test.sql`——
- 開賣：小賞總數不等於 N−1、庫存不足被拒；開賣後修改規則欄位或重新產生種子被拒。
- 開抽：餘額不足、格子重複、格子已被抽、超出範圍都整批失敗且不扣款；同一 `request_id` 重送不重複扣款；兩個會員搶同一格只有一個成功；**同一會員同時在 A、B 兩張開抽而餘額只夠一次，只成功一筆**。
- 大獎在批次中：整批成立、待發通知只寫一筆；`end_on_grand=true` 時活動結束、剩餘小賞保留釋放、種子公開；`false` 時活動繼續販售、種子不公開、可再開抽至售完。
- 保底顏色：開賣時保留 1 台；活動結束不釋放未兌換大獎的保底保留；未設 `end_on_grand` 或保底顏色不在大獎選項時建立被拒。
- 某款小賞最後一個被抽走：保留改設 `released_at`。
- authenticated 直接呼叫 `lottery_draw` 並帶他人 member_id 被拒。
- 售完、到期 cron、取消。
- 依公開資料重算 manifest、commitment 與對應表，與實際一致。
- 既有訂單建單、逾期清理、管理員確認在有抽獎保留時行為不變（依 Stage 1 結論補案例）。
**Status**：Not Started

### Stage 4：Worker API 與後台抽獎分頁
**Goal**：管理員可建草稿、設定小賞池與大獎選項、開賣、取消、查紀錄；設定盲盒分類。
**Success Criteria**：後台看不到未開格子的號碼；表單驗證（中獎號碼 1..N、小賞總數）即時提示；手機／平板／桌機版面正常。
**Tests**：`tests/worker/lottery-admin.test.mjs`（權限、輸入驗證、回應不含未開格子資料）；`npm run check:js`、`npm run typecheck`。
**Status**：Not Started

### Stage 5：前台活動頁、選格開抽與驗證
**Goal**：首頁區塊、`/lottery/:id` 選格、天選、開抽、刮開動畫、逾時查詢、結束後驗證。
**Success Criteria**：§6.2 全部成立；驗證區重算顯示通過；三種尺寸畫面正常；CSP 無違規；盤面輪詢負載已量測。
**Tests**：`tests/worker/lottery-public.test.mjs`（公開 API 不洩漏未開格子與 member_id、開抽 rate limit、天選由伺服器挑格、以 requestId 查詢）；`tests/frontend` 固定測試向量（JS 與 SQL 結果一致）；`wrangler dev`（8082）實際操作截圖。
**Status**：Not Started

### Stage 6：我的獎品、換券與獎品出貨
**Goal**：小賞換盲盒折抵券、大獎選色、勾選申請出貨、後台獎品出貨列表。
**Success Criteria**：換券為單一交易且庫存放回；券只能用在盲盒分類商品；大獎選色只能選有庫存的顏色，改選時保底保留正確釋放；出貨不重複扣庫存、不產生回饋點；店到店申請時扣運費、宅配依「報價 → 確認扣款 → 出貨」，任何情況餘額都不為負。
**Tests**：`tests/db/member_prizes.test.sql`（換券、重複換券被拒、別人的獎品被拒、選無庫存顏色被拒、選保底顏色／改選其他顏色的庫存與保留變化、重複選色被拒、出貨不重複扣庫存、店到店餘額不足申請被拒、宅配未報價不能確認、報價後餘額不足確認被拒、已付款不能取消、取消後獎品回到 held）；`tests/db/coupons.test.sql` 補分類券：購物車混放盲盒與一般商品、券面額大於盲盒小計（折抵額封頂）、一張訂單只能用一張券、用券後訂單取消時券的處理依既有規則；結帳 coupon-preview 測試補分類券。
**Status**：Not Started

### Stage 7：通知、整體驗收與上線
**Goal**：§7 通知、權限矩陣總檢、庫存與錢包對帳、部署。
**Success Criteria**：大獎、加值、申請出貨、宅配運費報價通知各觸發一次；未登入／會員／他人物件／管理員權限矩陣全部符合；`wallet_accounts` 與帳本一致；抽獎保留與 `stock_on_hand` 對帳一致；§1.1 已完成；完整 gate 通過後依 `AGENTS.md` 部署並 smoke。
**Tests**：通知文案與收件人離線測試（不實發 LINE）；`npm run check:js`、`npm run typecheck`、`npm test`、`npm run test:db`（或 CI database job）、`git diff --check`、`npx wrangler deploy --dry-run --minify`。
**Status**：Not Started

---

## 9. 日後再做

- 加值流程 B：客人線上填「儲值申請」回報匯款末五碼，管理員確認入帳（比照訂單回報匯款）。
- 包套：剩餘全買折扣，需先決定與「大獎抽走即結束」的關係與訂價。
- 分級一番賞（A～G 賞）：資料模型已預留，需擴充小賞池為多層級與配率顯示。
- 收益試算與營運報表（營收、獎品成本、未領獎負債、未使用儲值總額、未使用折抵券）（Q5）。

## 10. 業主決策紀錄（Stage 0）

| # | 項目 | 選項與建議 |
| --- | --- | --- |
| Q1 | ~~大獎抽走即結束的收益影響~~ | **已決定（2026-10-12）：c 每張活動自行設定**，見 §1 |
| Q2 | ~~大獎顏色保證~~ | **已決定（2026-10-12）：b 只保留一台，兌獎時選當下有貨的顏色**，見 §1 |
| Q3 | ~~宅配運費~~ | **已決定（2026-10-12）：a 報價 → 會員確認扣儲值金 → 出貨**，見 §1、§4.5 |
| Q4 | ~~店家主動取消販售中的活動~~ | **已決定：不補償已購買者**，見 §1、§4.4 |
| Q5 | ~~收益試算與營運報表~~ | **已決定：照預設，本次不納入任何 Stage**（列入 §9） |
| Q6 | ~~獎品保管期限~~ | **已決定：不設期限**；後台可查「保管超過 90 天」清單由客服聯繫 |
| Q7 | ~~出貨模型~~ | **已決定：採用 `prize_shipments`**（§4.5）；Stage 1 若發現重大障礙，記錄理由並回報業主後才改 |
| Q8 | ~~已開格子公開程度~~ | **已決定：顯示號碼與小賞名稱，不顯示會員** |
| Q9 | ~~單張活動上限／折抵券有效期~~ | **已決定：總抽數 2～1000；券有效期每張活動設定、預設 90 天** |

## 11. Codex 審查（2026-10-12）處理紀錄

| 建議 | 處理 |
| --- | --- |
| 法規提前為 Phase 0；補稅務、公平會揭露、最終解釋權 | 採納：Stage 0、§1.1 |
| 提前結束的收益試算 | 列為 Q1／Q5；業主決定 Q1＝每張活動自行設定 |
| 大獎顏色保證 | 採納分析，撤回原建議；業主決定 Q2＝只保留一台、選當下有貨的顏色 |
| 取消／退款情境分開定義 | 採納：§4.4；業主決定 Q4＝不補償 |
| 錢包雙層、不可變帳本、防重複加值、沖正 | 採納：§3.1（稽核沿用既有 `audit_logs`，不另建 wallet_audit） |
| 跨活動併發 | 原規劃以會員鎖涵蓋；採納固定鎖定順序並補測試 |
| 逾時先查詢再重送 | 採納：新增查詢 API |
| 擴大承諾範圍、揭露挑種子限制 | 採納：§4.3 manifest 與能力邊界 |
| 庫存保留共用或另建需先審查 | 採納：Stage 1 |
| 獎品出貨獨立模型 | 採納；業主決定 Q7＝採用 prize_shipments |
| 宅配運費與餘額不得為負衝突 | 採納；業主決定 Q3＝報價後確認扣款 |
| 換券單一交易、優惠券補測 | 採納：§4.5、Stage 6 |
| 確認視窗揭露整批成立規則、輪詢負載 | 採納：§6.2 |
| 另建 spec.md／todolist.md | 不採納：專案慣例為 `app/*_PLAN.md`，執行進度依使用者規則用 `TASKS.md` |
| 單檔上限改 450 行 | 不採納：專案規則為 500 行，如需調整由業主決定 |
| 階段順序改為後台與領獎在前台之前 | 部分採納：新增 Stage 0、1；其餘維持「後台 → 前台開抽 → 我的獎品」，因我的獎品依賴前台已能開抽產生資料 |
