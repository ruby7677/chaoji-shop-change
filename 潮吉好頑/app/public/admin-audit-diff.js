// 稽核紀錄的差異摘要（純函式）：把 before／after JSON 轉成「欄位：舊值 → 新值」，目標以名稱取代 UUID。
// 敏感欄位一律遮罩；時間戳記與內部 id 不列入差異。
const FIELD_LABELS = {
  name: "名稱", label: "名稱", sku: "SKU", code: "代碼", price: "售價", sale_price: "優惠價", sale_ends_at: "優惠截止",
  stock_on_hand: "庫存", safety_stock: "安全庫存", reserved_quantity: "保留量", kind: "類型", is_published: "上架",
  is_active: "啟用", display_order: "排序", purchase_limit: "限購", points_eligible: "可累積點數", deposit_rate: "訂金比例",
  seller_link: "賣貨便連結", description: "說明", category_id: "分類", bank_name: "銀行", bank_code: "銀行代碼",
  account_name: "戶名", account_number: "帳號", discount_amount: "折扣金額", combinable_with_points: "可與點數併用",
  per_member_limit: "每人次數", starts_at: "開始", ends_at: "結束", enabled: "啟用", points: "點數", reason: "原因",
  earn_amount: "每多少元 1 點", point_value: "每點折抵", min_redeem_points: "最低使用點數", max_redeem_mode: "折抵上限方式",
  max_redeem_value: "折抵上限", image_path: "圖片", balance: "點數餘額", delta: "異動點數"
};
const VALUE_LABELS = { kind: { in_stock: "現貨", stock: "現貨", preorder: "預購" } };
const IGNORED_FIELDS = new Set(["id", "created_at", "updated_at", "product_id", "image_updated_at"]);
const SECRET_FIELD = /account_number|channel_access_token|bot_token|secret|password/i;
const MAX_VALUE_LENGTH = 80;

function maskSecret(value) {
  const text = String(value ?? "");
  return text.length > 4 ? `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}` : "****";
}

export function formatAuditValue(field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (SECRET_FIELD.test(field)) return maskSecret(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  const mapped = VALUE_LABELS[field]?.[value];
  if (mapped) return mapped;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

const asRecord = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

// 只列出真的變動的欄位；新增或刪除時列出另一側有值的欄位
export function auditChanges(before, after) {
  const from = asRecord(before) || {};
  const to = asRecord(after) || {};
  const fields = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((field) => !IGNORED_FIELDS.has(field));
  return fields
    .filter((field) => JSON.stringify(from[field] ?? null) !== JSON.stringify(to[field] ?? null))
    .map((field) => ({
      field,
      label: FIELD_LABELS[field] || field,
      before: formatAuditValue(field, from[field]),
      after: formatAuditValue(field, to[field])
    }));
}

// 目標名稱：優先用資料本身的名稱／代碼；規格再補上商品名稱。都沒有時才退回原始 target
export function auditTargetName(entry, productNameById = () => "", memberNameById = () => "") {
  const record = asRecord(entry?.after_data) || asRecord(entry?.before_data) || {};
  const own = record.name || record.label || record.code || "";
  const productName = record.product_id ? productNameById(record.product_id) : "";
  const title = [productName, own].filter(Boolean).join("／");
  if (title) return title;
  // 會員點數等以會員 id 為目標：有會員資料時顯示姓名
  return (entry?.target && memberNameById(entry.target)) || entry?.target || "—";
}
