// 商品詳細介紹：把後台輸入的純文字轉成安全的 HTML。
// 規則：「名稱：內容」→ 規格表；「名稱：」單獨一行 → 小標題；「・／-／•」開頭 → 清單；空行分段；其餘為段落。
// 所有文字都先跳脫，不支援任何 HTML 或連結，避免 XSS。
import { escapeHtml } from "./product-format.js";

// 排除網址（https://…）與時間（14:00）被誤判成「名稱：內容」。
const SPEC_LINE = /^(?!\d+[：:])([^：:\n]{1,12})[：:](?!\/\/)\s*(\S.*)$/;
const HEADING_LINE = /^([^：:\n]{1,20})[：:]\s*$/;
const LIST_LINE = /^[・\-•]\s*(.+)$/;

function classify(line) {
  const list = line.match(LIST_LINE);
  if (list) return { kind: "list", text: list[1] };
  const heading = line.match(HEADING_LINE);
  if (heading) return { kind: "heading", text: heading[1] };
  const spec = line.match(SPEC_LINE);
  if (spec) return { kind: "spec", key: spec[1].trim(), value: spec[2].trim() };
  return { kind: "text", text: line };
}

function renderRun(kind, items) {
  if (kind === "spec") return `<dl class="pp-specs">${items.map((item) => `<div><dt>${escapeHtml(item.key)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join("")}</dl>`;
  if (kind === "list") return `<ul class="pp-details-list">${items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("")}</ul>`;
  if (kind === "heading") return items.map((item) => `<h3 class="pp-details-heading">${escapeHtml(item.text)}</h3>`).join("");
  return `<p>${items.map((item) => escapeHtml(item.text)).join("<br />")}</p>`;
}

export function formatProductDetails(text) {
  const blocks = String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const html = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    let run = [];
    let runKind = null;
    for (const line of lines) {
      const item = classify(line);
      if (item.kind !== runKind && run.length) { html.push(renderRun(runKind, run)); run = []; }
      runKind = item.kind;
      run.push(item);
    }
    if (run.length) html.push(renderRun(runKind, run));
  }
  return html.join("");
}
