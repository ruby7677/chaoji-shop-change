// 首頁第一張輪播圖：Worker 回傳首頁時寫入 <link rel="preload">，讓瀏覽器與 CSS／JS 同時下載這張圖，
// 不必等型錄 API 回來、輪播產生後才開始（PageSpeed LCP）。
// 選圖規則必須與 public/hero-slides.js 的 selectHeroSlides() 第一張相同（tests/worker/hero-preload.test.mjs 比對兩者）。
type HeroVariant = {
  id: string;
  product_id?: string;
  stock?: number;
  type?: string;
  image_url?: string;
  hero_rank?: number | null;
  display_order?: number;
};

type Candidate = { imageUrl: string; preorder: boolean; rank: number | null; order: number };

function candidate(variants: HeroVariant[]): Candidate | null {
  const lead = variants.find((variant) => Number(variant.stock || 0) > 0);
  if (!lead?.image_url) return null;
  return {
    imageUrl: lead.image_url,
    preorder: ["預購", "preorder"].includes(String(lead.type || "").toLowerCase()),
    rank: Number.isInteger(lead.hero_rank) ? Number(lead.hero_rank) : null,
    order: Number(lead.display_order || 0)
  };
}

export function firstHeroImageUrl(variants: HeroVariant[]): string | null {
  const groups = new Map<string, HeroVariant[]>();
  for (const variant of variants) {
    const key = variant.product_id || variant.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(variant);
  }
  const candidates = [...groups.values()].map(candidate).filter((item): item is Candidate => item !== null);
  const ranked = candidates.filter((item) => item.rank !== null).sort((a, b) => a.rank! - b.rank! || b.order - a.order);
  if (ranked.length) return ranked[0].imageUrl;
  const preorders = candidates.filter((item) => item.preorder).sort((a, b) => b.order - a.order);
  return preorders[0]?.imageUrl ?? null;
}
