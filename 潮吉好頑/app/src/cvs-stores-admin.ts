// 後台「7-11 門市」：逐縣市暫存 CSV 解析結果 → 發佈（指標最後寫入）→ 回復舊版或回到內建靜態檔。
// 儲存配置與驗證規則見 cvs-stores.ts。Workers Free 每次請求只有 50 個子請求、10ms CPU，
// 所以一個請求只處理一個縣市（≤128KB），發佈只靠 R2 list 回傳的伺服器端 metadata，不重讀各縣市檔內容。
import { requireAdmin } from "./auth";
import { CVS_CITY_SLUGS, CVS_KEEP_VERSIONS, CVS_MAX_SHRINK_RATIO, CVS_POINTER_KEY, CVS_PREFIX, CVS_SLUGS, CVS_VERSION_PATTERN, cvsVersionKey, validateCityData, type CvsCodes, type CvsManifest, type CvsPointer } from "./cvs-stores";
import { type Env } from "./env";
import { MAX_JSON_REQUEST_BYTES, json } from "./http";

const JSON_TYPE = { contentType: "application/json; charset=utf-8" };
const CITY_BY_SLUG: Record<string, string> = Object.fromEntries(Object.entries(CVS_CITY_SLUGS).map(([city, slug]) => [slug, city]));

type Admin = { user: { id: string } };

async function begin(request: Request, env: Env): Promise<{ admin: Admin; bucket: R2Bucket } | Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (!env.PRODUCT_IMAGES) return json({ error: "門市資料儲存空間（R2）尚未設定" }, { status: 503 });
  return { admin, bucket: env.PRODUCT_IMAGES };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_JSON_REQUEST_BYTES) return json({ error: "請求內容過大" }, { status: 413 });
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* 落到下面的錯誤回應 */ }
  return json({ error: "請求格式錯誤" }, { status: 400 });
}

function versionParam(value: unknown): string | null {
  return typeof value === "string" && CVS_VERSION_PATTERN.test(value) ? value : null;
}

function versionOf(key: string) {
  const match = key.match(/^cvs-stores\/(\d{14}-[0-9a-f]{6})\//);
  return match ? match[1] : null;
}

async function readPointer(bucket: R2Bucket): Promise<(CvsPointer & { publishedBy: string }) | null> {
  const object = await bucket.get(CVS_POINTER_KEY);
  if (!object) return null;
  try { return { ...await object.json<CvsPointer>(), publishedBy: object.customMetadata?.publishedBy || "" }; } catch { return null; }
}

async function readCodes(bucket: R2Bucket, version: string): Promise<CvsCodes> {
  const object = await bucket.get(cvsVersionKey(version, "codes"));
  if (!object) return {};
  try { return await object.json<CvsCodes>(); } catch { return {}; }
}

/** 暫存單一縣市：驗證後存成 <version>/<slug>.json，筆數與鄉鎮區由伺服器計算並記在 customMetadata。 */
export async function stageCvsCity(request: Request, env: Env): Promise<Response> {
  const ready = await begin(request, env);
  if (ready instanceof Response) return ready;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const version = versionParam(body.version);
  if (!version) return json({ error: "版本代號不正確" }, { status: 400 });
  const city = typeof body.city === "string" ? body.city : "";
  const slug = Object.hasOwn(CVS_CITY_SLUGS, city) ? CVS_CITY_SLUGS[city] : undefined;
  if (!slug) return json({ error: "不支援的縣市" }, { status: 400 });
  const checked = validateCityData(body.data);
  if (!checked.ok) return json({ error: `${city}：${checked.error}` }, { status: 400 });
  // 已發佈的版本不可再改寫（目前版本或回復目標都可能指向它）
  if (await ready.bucket.head(cvsVersionKey(version, "manifest"))) return json({ error: "此版本已發佈，請重新選擇檔案上傳" }, { status: 409 });
  const { data, count, districts, codes } = checked.value;
  // 店號在整份清單內必須唯一：和這個版本已暫存的其他縣市比對（重傳同一縣市時先扣掉它自己舊的）
  const staged = await readCodes(ready.bucket, version);
  delete staged[slug];
  const taken = new Set(Object.values(staged).flat());
  const clash = codes.find((code) => taken.has(code));
  if (clash) return json({ error: `${city}：店號 ${clash} 與其他縣市重複` }, { status: 400 });
  await ready.bucket.put(cvsVersionKey(version, slug), JSON.stringify(data), {
    httpMetadata: JSON_TYPE,
    customMetadata: { city, count: String(count), districts: JSON.stringify(districts) }
  });
  await ready.bucket.put(cvsVersionKey(version, "codes"), JSON.stringify({ ...staged, [slug]: codes }), { httpMetadata: JSON_TYPE });
  return json({ ok: true, version, city, count });
}

type StagedCity = { slug: string; city: string; count: number; districts: string[] };

function stagedFromList(objects: R2Object[], prefix: string): StagedCity[] {
  const cities: StagedCity[] = [];
  for (const object of objects) {
    const slug = object.key.slice(prefix.length).replace(/\.json$/, "");
    const meta = object.customMetadata;
    if (!CVS_SLUGS.has(slug) || !meta) continue;
    const count = Number(meta.count);
    let districts: unknown;
    try { districts = JSON.parse(meta.districts || "null"); } catch { districts = null; }
    if (!Number.isInteger(count) || count <= 0 || !Array.isArray(districts) || !districts.every((district) => typeof district === "string")) continue;
    cities.push({ slug, city: CITY_BY_SLUG[slug], count, districts: districts as string[] });
  }
  return cities;
}

/** 發佈：檢查縣市齊全與筆數沒有明顯縮水，依序寫 index → manifest → 指標（最後），再清掉太舊的版本。 */
export async function publishCvsStores(request: Request, env: Env): Promise<Response> {
  const ready = await begin(request, env);
  if (ready instanceof Response) return ready;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const version = versionParam(body.version);
  if (!version) return json({ error: "版本代號不正確" }, { status: 400 });
  const { bucket, admin } = ready;
  const pointer = await readPointer(bucket);
  if (pointer?.version === version) return json({ ok: true, version, total: pointer.total, already_published: true });
  const prefix = `${CVS_PREFIX}${version}/`;
  const listing = await bucket.list({ prefix, include: ["customMetadata"] });
  if (listing.truncated) return json({ error: "暫存內容異常，請重新上傳" }, { status: 409 });
  if (listing.objects.some((object) => object.key === cvsVersionKey(version, "manifest"))) return json({ error: "此版本已發佈" }, { status: 409 });
  const staged = stagedFromList(listing.objects, prefix);
  const codes = await readCodes(bucket, version);
  const bySlug = new Map(staged.map((city) => [city.slug, city]));
  const missing = Object.entries(CVS_CITY_SLUGS).filter(([, slug]) => !bySlug.has(slug)).map(([city]) => city);
  if (missing.length) return json({ error: `還有縣市尚未上傳：${missing.join("、")}` }, { status: 409 });
  // 暫存的店號清單必須和各縣市檔的筆數一致，且全版本不重複（stage 已檢查；這裡再確認沒有被中途改壞）
  const allCodes = staged.flatMap((city) => codes[city.slug] || []);
  if (staged.some((city) => (codes[city.slug] || []).length !== city.count) || new Set(allCodes).size !== allCodes.length) {
    return json({ error: "暫存內容不一致或店號重複，請重新上傳" }, { status: 409 });
  }
  const total = staged.reduce((sum, city) => sum + city.count, 0);
  if (pointer && pointer.total > 0 && (pointer.total - total) / pointer.total > CVS_MAX_SHRINK_RATIO) {
    return json({ error: `新版門市共 ${total} 間，比目前的 ${pointer.total} 間少超過 ${CVS_MAX_SHRINK_RATIO * 100}%，已拒絕發佈` }, { status: 409 });
  }
  const index = Object.entries(CVS_CITY_SLUGS).map(([city, slug]) => [city, slug, (bySlug.get(slug) as StagedCity).districts]);
  const publishedAt = new Date().toISOString();
  const manifest: CvsManifest = { version, total, cities: Object.fromEntries(staged.map((city) => [city.slug, city.count])), publishedAt };
  await bucket.put(cvsVersionKey(version, "index"), JSON.stringify(index), { httpMetadata: JSON_TYPE });
  await bucket.put(cvsVersionKey(version, "manifest"), JSON.stringify(manifest), { httpMetadata: JSON_TYPE, customMetadata: { total: String(total), publishedAt, publishedBy: admin.user.id } });
  const next: CvsPointer = { version, total, publishedAt };
  await bucket.put(CVS_POINTER_KEY, JSON.stringify(next), { httpMetadata: JSON_TYPE, customMetadata: { publishedBy: admin.user.id } });
  await pruneVersions(bucket, version).catch((error) => console.error("門市舊版本清理失敗", error));
  return json({ ok: true, version, total });
}

/** 保留最近 CVS_KEEP_VERSIONS 個已發佈版本與目前版本；更舊的已發佈版本與比目前版本舊的未發佈暫存一併刪除。 */
async function pruneVersions(bucket: R2Bucket, currentVersion: string) {
  const listing = await bucket.list({ prefix: CVS_PREFIX });
  if (listing.truncated) return;
  const keysByVersion = new Map<string, string[]>();
  const published = new Set<string>();
  for (const object of listing.objects) {
    const version = versionOf(object.key);
    if (!version) continue;
    keysByVersion.set(version, [...(keysByVersion.get(version) || []), object.key]);
    if (object.key === cvsVersionKey(version, "manifest")) published.add(version);
  }
  const keep = new Set([currentVersion, ...[...published].sort().reverse().slice(0, CVS_KEEP_VERSIONS)]);
  const doomed: string[] = [];
  for (const [version, keys] of keysByVersion) {
    if (keep.has(version)) continue;
    if (published.has(version) || version < currentVersion) doomed.push(...keys);
  }
  if (doomed.length) await bucket.delete(doomed);
}

/** 回復：指向保留中的舊版本；version 為 null 或 "baseline" 時刪除指標，回到 repo 內建的靜態檔。 */
export async function rollbackCvsStores(request: Request, env: Env): Promise<Response> {
  const ready = await begin(request, env);
  if (ready instanceof Response) return ready;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const { bucket, admin } = ready;
  if (body.version === null || body.version === "baseline") {
    await bucket.delete(CVS_POINTER_KEY);
    return json({ ok: true, version: null });
  }
  const version = versionParam(body.version);
  if (!version) return json({ error: "版本代號不正確" }, { status: 400 });
  const manifestObject = await bucket.get(cvsVersionKey(version, "manifest"));
  if (!manifestObject) return json({ error: "找不到這個版本（可能已被清除）" }, { status: 404 });
  const manifest = await manifestObject.json<CvsManifest>();
  const next: CvsPointer = { version, total: manifest.total, publishedAt: new Date().toISOString() };
  await bucket.put(CVS_POINTER_KEY, JSON.stringify(next), { httpMetadata: JSON_TYPE, customMetadata: { publishedBy: admin.user.id } });
  return json({ ok: true, version, total: manifest.total });
}

/** 後台面板資料：目前版本、已發佈的歷史版本、尚未發佈的暫存。 */
export async function listCvsStores(request: Request, env: Env): Promise<Response> {
  const ready = await begin(request, env);
  if (ready instanceof Response) return ready;
  const { bucket } = ready;
  const [pointer, listing] = await Promise.all([readPointer(bucket), bucket.list({ prefix: CVS_PREFIX, include: ["customMetadata"] })]);
  const versions = new Map<string, R2Object[]>();
  for (const object of listing.objects) {
    const version = versionOf(object.key);
    if (version) versions.set(version, [...(versions.get(version) || []), object]);
  }
  const published: Array<{ version: string; total: number; published_at: string; published_by: string; is_current: boolean }> = [];
  const staged: Array<{ version: string; cities: string[]; uploaded_at: string }> = [];
  for (const [version, objects] of versions) {
    const manifest = objects.find((object) => object.key === cvsVersionKey(version, "manifest"));
    if (manifest) {
      published.push({ version, total: Number(manifest.customMetadata?.total) || 0, published_at: manifest.customMetadata?.publishedAt || "", published_by: manifest.customMetadata?.publishedBy || "", is_current: pointer?.version === version });
    } else {
      const cities = stagedFromList(objects, `${CVS_PREFIX}${version}/`).map((city) => city.city);
      const latest = Math.max(...objects.map((object) => object.uploaded.getTime()));
      staged.push({ version, cities, uploaded_at: new Date(latest).toISOString() });
    }
  }
  published.sort((a, b) => b.version.localeCompare(a.version));
  staged.sort((a, b) => b.version.localeCompare(a.version));
  return json({ current: pointer, published, staged: staged.slice(0, 3), city_count: Object.keys(CVS_CITY_SLUGS).length });
}
