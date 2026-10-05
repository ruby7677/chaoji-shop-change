// Worker 環境變數與跨模組共用的資料型別。

export interface Env {
  ASSETS: Fetcher;
  STORE_NAME: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_CUSTOM_PROVIDER?: string;
  LINE_AUTH_ENABLED?: string;
  LIFF_ID?: string;
  LINE_LOGIN_CHANNEL_ID?: string;
  AUTH_SESSION_SECRET?: string;
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?: string;
  LINE_NOTIFY_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_CHAT_IDS?: string;
  TELEGRAM_NOTIFY_ENABLED?: string;
  API_ORDER_RATE_LIMITER?: RateLimit;
  API_MEMBER_RATE_LIMITER?: RateLimit;
  API_ADMIN_RATE_LIMITER?: RateLimit;
  API_AUTH_IP_RATE_LIMITER?: RateLimit;
}

export type Product = {
  id: string;
  category: string;
  /** 分類（系列）在後台設定的排序，數字小的排前面；前台系列按鈕依此排列。 */
  category_order?: number;
  name: string;
  product_id?: string;
  product_name?: string;
  description?: string;
  variant_name?: string;
  purchase_limit?: number | null;
  points_eligible?: boolean;
  compare_at_price?: number | null;
  price: number;
  stock: number;
  type: "現貨" | "預購";
  preorder_arrival?: string;
  seller_link?: string;
  image_url?: string;
  hero_rank?: number | null;
  hero_tagline?: string | null;
};

export type AuthUser = {
  id: string;
  user_metadata?: Record<string, unknown>;
  identities?: Array<{ provider?: string; identity_data?: Record<string, unknown> }>;
};
