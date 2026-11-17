# 潮吉好頑：架構與更新規則

改程式前讀這份（約 80 行）。業務規則、部署流程在上一層 `AGENTS.md`，這裡只管「程式放哪、模組怎麼互相引用」。
規則由 `tests/frontend/module-graph.test.mjs` 把關：違反時 `npm test` 會失敗並說明原因。

## 先查再讀（省 token）

不要整份讀大檔。先用工具定位，再讀需要的段落：

```bash
node scripts/module-graph.mjs            # 全站摘要：循環群、最大檔、被引用最多的模組
node scripts/module-graph.mjs cart       # 單一模組：引用誰、被誰引用、匯出什麼
```

找函式或選擇器用 `rg -n`。歷史文件（`docs/history/`、已完成的 `*_PLAN.md`）不用讀。

## 分層（只能往下引用）

| 層 | 模組 | 可以引用 |
| --- | --- | --- |
| 入口 | `app.js`、`orders-page.js`、`admin-loader.js` | 全部；負責事件接線與注入 |
| 流程 | `checkout-*.js`、`member-*.js`、`liff-session.js`、`auth-return-state.js` | 狀態層、基礎層 |
| 狀態 | `cart.js`、`storefront-catalog.js`、`admin-app.js` | 狀態層、基礎層（不可引用流程與入口） |
| 基礎 | `app-core.js`、`product-format.js`、`cart-merge.js`、`cart-quantity.js`、`cart-delivery-rules.js` 等純函式模組 | 只能引用基礎層 |

- 前台不可靜態 import 後台，只能經 `admin-loader.js` 動態載入。
- Worker（`src/*.ts`）不能 import `public/`；兩邊都要的常數各放一份並用測試比對（例：縣市白名單）。

## 需要「往上呼叫」時的寫法

下層要觸發上層的動作時，不要 import 上層，改用下面兩種既有做法：

1. **注入（一個呼叫點）**：下層匯出 setter，入口設定。
   例：`cart.js` 的 `setCheckoutOpener(open)`，由 `app.js` 呼叫 `setCheckoutOpener(openCheckout)`。
2. **註冊（多個擁有者）**：核心匯出 `Map`，各模組載入時自行註冊。
   例：`admin-app.js` 的 `adminSectionRenderers`（分區 → 渲染函式）與 `adminTabHooks`（自行載入的分頁）。

跨模組修改狀態：由擁有狀態的模組匯出函式（例：`selectCheckoutScope()`、`forgetCartSyncUser()`），不可從外部指定別人的 `let`。

## 新東西放哪

| 要加的東西 | 放哪 | 接線 |
| --- | --- | --- |
| 純計算、格式化 | 新的基礎模組＋同名測試 `tests/frontend/<name>.test.mjs` | 被需要的模組 import |
| 前台新功能 | 新的 `public/<feature>.js`，匯出 `init…(deps)` | `app.js` 加 import 與一行接線 |
| 後台新分頁（走 dashboard API） | 面板內 `adminSectionRenderers.set("<section>", render)` | `admin-app.js` 的 `adminSections`（要換頁再加 `adminSectionPages`）、`src/admin-dashboard.ts` 的 `ADMIN_DASHBOARD_SECTIONS`、`admin-loader.js` 的載入清單。漏列 `adminSections` 會靜默顯示成概況 |
| 後台新分頁（自行載入） | 新模組內 `adminTabHooks.set("<tab>", load)` | `admin-loader.js` 的載入清單 |
| 前台樣式 | 對應功能的 CSS 檔 | `scripts/build-css.mjs` 的 `CSS_BUNDLES`，不另加 `<link>` |
| Worker 端點 | 新的 `src/<feature>.ts` | `src/index.ts` 只加路由 |

## 禁止事項

- 不新增循環 import。測試裡的 `KNOWN_CYCLE` 只能縮小，不可加入新模組。
- 單檔不超過 500 行；`cart.js`、`admin-products-table.js` 已接近上限，新功能放新檔。
- `:hover` 一律包在 `@media (hover: hover)`；動態 HTML 不寫 `style="…"`（CSP）。
- 不為了「之後可能用到」先加抽象、參數或設定；沒有第二個使用者就不抽共用。
- 不留沒人呼叫的函式與沒人用的 import；移除功能時連同樣式、測試一起移除。
- 不重複 `app-core.js` 已有的工具（`showToast`、`showDialog`、`formatDateTime`…），先查匯出清單。

## 改完必跑

```bash
node scripts/build-modulepreload.mjs   # 改了前台 import 之後
node scripts/build-css.mjs             # 改了前台 CSS 之後
npm run check:js
npm run typecheck
npm test
```

`node --check` 不檢查 import 名稱，寫錯會讓瀏覽器整棵 module 樹載入失敗；`module-graph.test.mjs` 會先擋下。
畫面與登入後的流程（結帳、會員、後台）測試涵蓋不到，要在 `worker-dev` 預覽或實機確認，沒驗到要明講。

## 尚未解開的耦合（動它之前先讀）

`KNOWN_CYCLE` 的 8 個模組（登入、會員、結帳）互相呼叫，是付款路徑，本機無法登入實測，所以保留。
要拆時一次只拆一條邊，用上面的注入寫法，並在實機走完「登入 → 加入購物車 → 結帳 → 回報匯款」再部署。
建議順序：`liff-session.js` 對 `cart`／`member-benefits`／`auth-return-state` 的三個呼叫改由 `member-profile.js` 注入，
再處理 `member-benefits.js` 對 `checkout-flow.js` 的 `openCheckout`。
