// 後台「預購叫貨」：依預購規格統計各階段的訂購件數，供店主決定向上游叫多少。
// 以訂單明細（order_items）為準，不看庫存異動：建單只保留庫存、確認收款才扣庫存，待付款／待核對的訂單不會出現在異動裡。
import { requireAdmin } from "./auth";
import { databaseError } from "./database-errors";
import { type Env } from "./env";
import { fetchWithTimeout, json, serviceHeaders } from "./http";

// 未付款：保留中，2 小時內沒付會自動取消；已付款：已扣庫存、等商品到貨；已到貨：商品到貨通知後或已完成交付。
const UNPAID_STATUSES = ["pending_payment", "pending_review"];
const PAID_STATUSES = ["confirmed", "partially_ready"];
const ARRIVED_STATUSES = ["ready_for_pickup", "completed"];
const COUNTED_STATUSES = [...UNPAID_STATUSES, ...PAID_STATUSES, ...ARRIVED_STATUSES];
const PAGE_SIZE = 1000;
const MAX_PAGES = 30;

export type PreorderItemRow = {
  variant_id: string;
  product_name: string;
  variant_name: string;
  quantity: number;
  arrival_snapshot: string | null;
  orders: { status: string } | { status: string }[] | null;
};

export type PreorderDemandRow = {
  variant_id: string;
  product_name: string;
  variant_name: string;
  arrival: string | null;
  unpaid: number;
  paid: number;
  arrived: number;
};

export function aggregatePreorderDemand(rows: PreorderItemRow[]): PreorderDemandRow[] {
  const byVariant = new Map<string, PreorderDemandRow>();
  for (const row of rows) {
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const status = order?.status;
    const quantity = Number(row.quantity) || 0;
    if (!status || quantity <= 0 || !COUNTED_STATUSES.includes(status)) continue;
    const entry = byVariant.get(row.variant_id) || {
      variant_id: row.variant_id,
      product_name: row.product_name,
      variant_name: row.variant_name,
      arrival: row.arrival_snapshot || null,
      unpaid: 0,
      paid: 0,
      arrived: 0
    };
    if (UNPAID_STATUSES.includes(status)) entry.unpaid += quantity;
    else if (PAID_STATUSES.includes(status)) entry.paid += quantity;
    else entry.arrived += quantity;
    byVariant.set(row.variant_id, entry);
  }
  return [...byVariant.values()].sort((a, b) =>
    b.paid - a.paid || b.unpaid - a.unpaid || a.product_name.localeCompare(b.product_name, "zh-Hant") || a.variant_name.localeCompare(b.variant_name, "zh-Hant"));
}

export async function adminPreorderDemand(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const rows: PreorderItemRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/order_items`);
    url.searchParams.set("select", "variant_id,product_name,variant_name,quantity,arrival_snapshot,orders!inner(status)");
    url.searchParams.set("kind", "eq.preorder");
    url.searchParams.set("orders.status", `in.(${COUNTED_STATUSES.join(",")})`);
    url.searchParams.set("order", "id.asc");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(page * PAGE_SIZE));
    const response = await fetchWithTimeout(url, { headers: serviceHeaders(env) });
    if (!response.ok) return databaseError(response);
    const batch = await response.json() as PreorderItemRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return json({ preorderDemand: aggregatePreorderDemand(rows) });
  }
  return json({ error: "預購訂單筆數過多，無法一次統計" }, { status: 413 });
}
