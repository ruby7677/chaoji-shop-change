// 前端模組依賴的守門測試（規則見 ARCHITECTURE_RULES.md）：
// import 名稱都對得到 export、沒有循環依賴、單檔不超過 500 行、後台每個分區都有註冊渲染函式。
// node --check 不做連結，import 名稱寫錯要到瀏覽器才會整棵 module 樹載入失敗；這裡先擋下。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_LINES, PUBLIC_DIR, brokenImports, cycles, loadGraph, parseModule, staticDeps } from "../../scripts/module-graph.mjs";

// 流程層：可互相引用但不可成環；checkout-flow 在最上方，只有入口可以 import
const FLOW_MODULES = ["auth-return-state", "checkout-coupon", "checkout-flow", "checkout-form", "liff-session", "member-benefits", "member-orders", "member-profile"];
// 不可依賴頁面流程的基礎模組：只能引用其他基礎模組或純函式模組
const LEAF_MODULES = ["app-core", "product-format", "cart-delivery-rules", "cart-merge", "cart-quantity"];
// 狀態層：可被流程層引用，自己不可引用流程層或入口
const STATE_MODULES = ["cart", "checkout-state", "storefront-catalog", "admin-app"];
const ENTRY_MODULES = ["app", "orders-page", "admin-loader"];

const graph = await loadGraph();

test("every named import resolves to an export of the target module", () => {
  assert.deepEqual(brokenImports(graph), []);
});

test("there is no import cycle", () => {
  assert.deepEqual(cycles(graph), [], "new import cycle: inject the function from the entry module or move shared state to a lower module");
});

test("only entry modules import the checkout flow", () => {
  const importers = Object.keys(graph).filter((name) => staticDeps(graph, name).includes("checkout-flow"));
  assert.deepEqual(importers.filter((name) => !ENTRY_MODULES.includes(name)), [], "call startCheckout() from cart.js instead");
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
  const upper = new Set([...FLOW_MODULES, ...STATE_MODULES, ...ENTRY_MODULES]);
  const offenders = LEAF_MODULES.flatMap((name) => staticDeps(graph, name).filter((dep) => upper.has(dep)).map((dep) => `${name} -> ${dep}`));
  assert.deepEqual(offenders, []);
});

test("state modules do not import flow or entry modules", () => {
  const upper = new Set([...FLOW_MODULES, ...ENTRY_MODULES]);
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
