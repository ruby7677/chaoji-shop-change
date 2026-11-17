// 前端模組依賴的守門測試（規則見 ARCHITECTURE_RULES.md）：
// import 名稱都對得到 export、循環依賴只減不增、單檔不超過 500 行、後台每個分區都有註冊渲染函式。
// node --check 不做連結，import 名稱寫錯要到瀏覽器才會整棵 module 樹載入失敗；這裡先擋下。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_LINES, PUBLIC_DIR, brokenImports, cycles, loadGraph, parseModule, staticDeps } from "../../scripts/module-graph.mjs";

// 目前還留著的循環群（登入／會員／結帳流程互相呼叫）。只能縮小：拆掉一個就從這裡移除，不可加入新模組。
const KNOWN_CYCLE = ["auth-return-state", "checkout-coupon", "checkout-flow", "checkout-form", "liff-session", "member-benefits", "member-orders", "member-profile"];
// 不可依賴頁面流程的基礎模組：只能引用其他基礎模組或純函式模組
const LEAF_MODULES = ["app-core", "product-format", "cart-delivery-rules", "cart-merge", "cart-quantity"];
// 狀態層：可被流程層引用，自己不可引用流程層或入口
const STATE_MODULES = ["cart", "storefront-catalog", "admin-app"];
const ENTRY_MODULES = ["app", "orders-page", "admin-loader"];

const graph = await loadGraph();

test("every named import resolves to an export of the target module", () => {
  assert.deepEqual(brokenImports(graph), []);
});

test("no module joins an import cycle (the known checkout/member cycle may only shrink)", () => {
  const cyclic = cycles(graph).flat();
  assert.deepEqual(cyclic.filter((name) => !KNOWN_CYCLE.includes(name)), [], "new import cycle: inject the function from the entry module or move shared state to a leaf module");
  assert.deepEqual(KNOWN_CYCLE.filter((name) => !cyclic.includes(name)), [], "a module left the cycle: remove it from KNOWN_CYCLE");
});

test("the admin core does not import any admin panel", () => {
  assert.deepEqual(staticDeps(graph, "admin-app").filter((name) => name.endsWith("-panel")), []);
});

test("the storefront reaches the admin only through its lazy loader", () => {
  const offenders = Object.keys(graph)
    .filter((name) => !name.startsWith("admin"))
    .flatMap((name) => staticDeps(graph, name).filter((dep) => dep.startsWith("admin") && !["admin-loader", "admin-tab"].includes(dep)).map((dep) => `${name} -> ${dep}`));
  assert.deepEqual(offenders, []);
});

test("leaf modules do not import page flow modules", () => {
  const cyclic = new Set(cycles(graph).flat());
  const offenders = LEAF_MODULES.flatMap((name) => staticDeps(graph, name).filter((dep) => cyclic.has(dep) || dep === "app" || dep === "cart").map((dep) => `${name} -> ${dep}`));
  assert.deepEqual(offenders, []);
});

test("state modules do not import flow or entry modules", () => {
  const upper = new Set([...KNOWN_CYCLE, ...ENTRY_MODULES]);
  const offenders = STATE_MODULES.flatMap((name) => staticDeps(graph, name).filter((dep) => upper.has(dep) || dep.endsWith("-panel")).map((dep) => `${name} -> ${dep}`));
  assert.deepEqual(offenders, []);
});

test(`no frontend module is longer than ${MAX_LINES} lines`, () => {
  assert.deepEqual(Object.entries(graph).filter(([, info]) => info.lines > MAX_LINES).map(([name, info]) => `${name}.js: ${info.lines}`), []);
});

test("each admin section is registered by exactly one panel", async () => {
  const registered = [];
  for (const name of Object.keys(graph).filter((module) => module.startsWith("admin"))) {
    const source = await readFile(join(PUBLIC_DIR, `${name}.js`), "utf8");
    for (const [, section] of source.matchAll(/adminSectionRenderers\.set\("([^"]+)"/g)) registered.push(section);
  }
  // 分區清單以 admin-app.js 的 adminSections 為準（overview 由核心自己畫）
  const core = await readFile(join(PUBLIC_DIR, "admin-app.js"), "utf8");
  const sections = JSON.parse(core.match(/const adminSections = (\[[^\]]*\]);/)[1]).filter((section) => section !== "overview");
  assert.ok(sections.length > 0);
  assert.deepEqual(registered.sort(), sections.sort());
});

test("parseModule reads named imports, re-exports and dynamic imports", () => {
  const parsed = parseModule('import { a, b as c } from "./x.js";\nexport { d as e } from "./y.js";\nexport async function f() { return import("./z.js"); }\n// import { ignored } from "./comment.js";\n');
  assert.deepEqual(parsed.imports, [{ from: "x", names: ["a", "b"] }, { from: "y", names: ["d"] }]);
  assert.deepEqual([...parsed.exports], ["f", "e"]);
  assert.deepEqual(parsed.dynamic, ["z"]);
});

test("brokenImports reports a missing export and a missing file", () => {
  const fake = {
    a: parseModule(['import { present, absent } from "./b.js";', 'import { x } from "./gone.js";', 'export const loader = () => import("./lazy-gone.js");'].join("\n")),
    b: parseModule("export const present = 1;")
  };
  assert.deepEqual(brokenImports(fake), ['a.js: import("./lazy-gone.js") 找不到檔案', "a.js: b.js 沒有匯出 absent", 'a.js: "./gone.js" 找不到檔案']);
});
