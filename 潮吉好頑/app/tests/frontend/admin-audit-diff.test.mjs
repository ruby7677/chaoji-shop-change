import test from "node:test";
import assert from "node:assert/strict";
import { auditChanges, auditTargetName, formatAuditValue } from "../../public/admin-audit-diff.js";

const before = { id: "v1", sku: "CJ-UX11-ASIA", name: "單一規格", kind: "in_stock", price: 3299, product_id: "p1", updated_at: "2026-09-27T17:18:54Z" };
const after = { ...before, sku: "CJ-CX13-ASIA", updated_at: "2026-09-28T01:19:00Z" };

test("只列出真正變動的欄位，忽略時間戳記與內部 id", () => {
  assert.deepEqual(auditChanges(before, after), [{ field: "sku", label: "SKU", before: "CJ-UX11-ASIA", after: "CJ-CX13-ASIA" }]);
});

test("新增時列出新資料的欄位，舊值為「—」", () => {
  const changes = auditChanges(null, { name: "新商品", is_published: true });
  assert.deepEqual(changes.map((change) => [change.label, change.before, change.after]), [["名稱", "—", "新商品"], ["上架", "—", "是"]]);
});

test("敏感欄位遮罩，不顯示原值", () => {
  const [change] = auditChanges({ account_number: "123456789012" }, { account_number: "987654321098" });
  assert.equal(change.before, "********9012");
  assert.equal(change.after, "********1098");
});

test("類型與布林值轉成中文，過長內容截斷", () => {
  assert.equal(formatAuditValue("kind", "preorder"), "預購");
  assert.equal(formatAuditValue("is_active", false), "否");
  assert.equal(formatAuditValue("description", "x".repeat(200)).length, 80);
});

test("目標以商品／規格名稱取代 UUID（SKU 是內部欄位，不再附在名稱後）", () => {
  const entry = { target: "v1", before_data: before, after_data: after };
  assert.equal(auditTargetName(entry, (id) => (id === "p1" ? "CX-13 龍王閃擊" : "")), "CX-13 龍王閃擊／單一規格");
  assert.equal(auditTargetName(entry), "單一規格");
});

test("沒有可用名稱時退回原始 target", () => {
  assert.equal(auditTargetName({ target: "abc", before_data: null, after_data: { points: 10 } }), "abc");
});

test("會員點數紀錄：餘額欄位翻譯，目標顯示會員姓名", () => {
  const [change] = auditChanges({ balance: 34 }, { balance: 30 });
  assert.equal(change.label, "點數餘額");
  const entry = { target: "m1", before_data: { balance: 34 }, after_data: { balance: 30 } };
  assert.equal(auditTargetName(entry, () => "", (id) => (id === "m1" ? "建育" : "")), "建育");
});
