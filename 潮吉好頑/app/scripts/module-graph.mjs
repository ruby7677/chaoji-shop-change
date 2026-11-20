// 前端模組依賴圖（public/*.js）：靜態 import 的循環群、命名匯入是否對得到匯出、各檔行數。
// 規則見 ARCHITECTURE_RULES.md，由 tests/frontend/module-graph.test.mjs 把關。
// 直接執行可查詢，不必把檔案讀進來：
//   node scripts/module-graph.mjs            摘要（循環群、最大檔、被引用最多的模組）
//   node scripts/module-graph.mjs cart       列出 cart.js 引用誰、被誰引用、匯出什麼
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
export const MAX_LINES = 500;

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const moduleName = (specifier) => specifier.replace(/^\.\//, "").replace(/\.js$/, "");
const splitNames = (list) => list.split(",").map((part) => part.trim()).filter(Boolean);

/** 解析一個模組的原始碼：靜態／動態 import 的對象、命名匯入、匯出名稱。 */
export function parseModule(source) {
  const code = stripComments(source);
  const imports = [];
  for (const [, names, specifier] of code.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*["'](\.\/[^"']+)["']/gm)) {
    imports.push({ from: moduleName(specifier), names: splitNames(names).map((name) => name.split(/\s+as\s+/)[0]) });
  }
  for (const [, specifier] of code.matchAll(/^\s*import\s*(?:\*\s*as\s+\w+\s*from\s*)?["'](\.\/[^"']+)["']/gm)) {
    imports.push({ from: moduleName(specifier), names: [] });
  }
  const exports = new Set();
  const reexports = [];
  for (const [, name] of code.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) exports.add(name);
  for (const [, names, specifier] of code.matchAll(/^\s*export\s*\{([^}]*)\}(?:\s*from\s*["'](\.\/[^"']+)["'])?/gm)) {
    for (const name of splitNames(names)) exports.add(name.split(/\s+as\s+/).pop());
    if (specifier) imports.push({ from: moduleName(specifier), names: splitNames(names).map((name) => name.split(/\s+as\s+/)[0]) });
  }
  for (const [, specifier] of code.matchAll(/^\s*export\s*\*\s*from\s*["'](\.\/[^"']+)["']/gm)) reexports.push(moduleName(specifier));
  const dynamic = [...code.matchAll(/import\(\s*["'](\.\/[^"']+)["']\s*\)/g)].map(([, specifier]) => moduleName(specifier));
  return { imports, exports, reexports, dynamic, lines: source.split("\n").length };
}

/** 讀取 public/*.js，回傳 { 模組名: parseModule 結果 }。 */
export async function loadGraph(dir = PUBLIC_DIR) {
  const graph = {};
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".js")).sort()) {
    graph[file.replace(/\.js$/, "")] = parseModule(await readFile(join(dir, file), "utf8"));
  }
  return graph;
}

export const staticDeps = (graph, name) => [...new Set([...graph[name].imports.map((entry) => entry.from), ...graph[name].reexports])];

/** 靜態 import 的循環群（強連通分量，大小 > 1），各群與群內成員皆排序。 */
export function cycles(graph) {
  let counter = 0;
  const stack = [], onStack = new Set(), index = {}, low = {}, found = [];
  const visit = (node) => {
    index[node] = low[node] = counter++;
    stack.push(node); onStack.add(node);
    for (const dep of staticDeps(graph, node)) {
      if (!graph[dep]) continue;
      if (index[dep] === undefined) { visit(dep); low[node] = Math.min(low[node], low[dep]); }
      else if (onStack.has(dep)) low[node] = Math.min(low[node], index[dep]);
    }
    if (low[node] !== index[node]) return;
    const group = [];
    let member;
    do { member = stack.pop(); onStack.delete(member); group.push(member); } while (member !== node);
    if (group.length > 1) found.push(group.sort());
  };
  for (const node of Object.keys(graph)) if (index[node] === undefined) visit(node);
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

/** 找不到對象檔案、或命名匯入對不到匯出的 import（上線後會讓整棵 module 樹載入失敗）。 */
export function brokenImports(graph) {
  const exported = (name, seen = new Set()) => {
    if (!graph[name] || seen.has(name)) return new Set();
    seen.add(name);
    return new Set([...graph[name].exports, ...graph[name].reexports.flatMap((dep) => [...exported(dep, seen)])]);
  };
  const problems = [];
  for (const [name, info] of Object.entries(graph)) {
    for (const target of info.dynamic) if (!graph[target]) problems.push(`${name}.js: import("./${target}.js") 找不到檔案`);
    for (const { from, names } of info.imports) {
      if (!graph[from]) { problems.push(`${name}.js: "./${from}.js" 找不到檔案`); continue; }
      const available = exported(from);
      for (const imported of names) if (!available.has(imported)) problems.push(`${name}.js: ${from}.js 沒有匯出 ${imported}`);
    }
  }
  return problems;
}

export function fanIn(graph) {
  const counts = Object.fromEntries(Object.keys(graph).map((name) => [name, []]));
  for (const name of Object.keys(graph)) for (const dep of staticDeps(graph, name)) counts[dep]?.push(name);
  return counts;
}

async function main([target]) {
  const graph = await loadGraph();
  const importers = fanIn(graph);
  if (target) {
    const name = moduleName(`./${target}`);
    if (!graph[name]) throw new Error(`public/${name}.js 不存在`);
    console.log(`${name}.js（${graph[name].lines} 行）`);
    console.log(`引用：${staticDeps(graph, name).join(", ") || "無"}`);
    console.log(`動態載入：${graph[name].dynamic.join(", ") || "無"}`);
    console.log(`被引用：${importers[name].join(", ") || "無"}`);
    console.log(`匯出：${[...graph[name].exports].join(", ") || "無"}`);
    return;
  }
  const names = Object.keys(graph);
  console.log(`${names.length} 個模組，${names.reduce((sum, name) => sum + graph[name].lines, 0)} 行`);
  console.log(`循環群：${cycles(graph).map((group) => `[${group.join(", ")}]`).join(" ") || "無"}`);
  console.log(`最大檔：${[...names].sort((a, b) => graph[b].lines - graph[a].lines).slice(0, 8).map((name) => `${name}:${graph[name].lines}`).join(" ")}`);
  console.log(`被引用最多：${[...names].sort((a, b) => importers[b].length - importers[a].length).slice(0, 8).map((name) => `${name}:${importers[name].length}`).join(" ")}`);
  const broken = brokenImports(graph);
  console.log(`壞掉的 import：${broken.length ? `\n  ${broken.join("\n  ")}` : "無"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
