// 後台商品多圖管理（批量上傳、排序、刪除）與商品頁／首頁輪播展示設定。
// 依賴由 app.js 以 initAdminProductGallery() 注入；事件掛在 document，重新渲染後不需重綁。
import { escapeHtml } from "./product-format.js";

const MAX_IMAGES = 10;
const DETAILS_MAX = 8000;
const TAGLINE_MAX = 80;
const HERO_RANK_MAX = 12;
// 刪除採畫面內兩段式確認（第一次按變成「確定刪除？」，此時間內再按才刪除）：
// 不用系統確認視窗，部分瀏覽器／內嵌 WebView 會直接略過或回傳 false，導致按了沒反應。
const DELETE_CONFIRM_MS = 3000;
const deleteTimers = new WeakMap();

let deps = null;
const busyProducts = new Set();
// 本次工作階段剛上傳的照片以 data: URL 預覽（CSP 不允許 blob:）；未上架商品的公開圖片路由會回 404。
const localPreviews = new Map();

function sortedImages(product) {
  return [...(product?.product_images || [])].sort((a, b) => a.sort_order - b.sort_order);
}

function imageUrl(productId, image) {
  return localPreviews.get(image.id) || `/api/product-images/${productId}/${image.id}?v=${encodeURIComponent(image.updated_at || "1")}`;
}

function galleryItemMarkup(product, image, index, total) {
  const position = index + 1;
  return `<li class="admin-gallery-item" data-image-id="${escapeHtml(image.id)}"><figure><img src="${escapeHtml(imageUrl(product.id, image))}" alt="${escapeHtml(product.name)} 第 ${position} 張" loading="lazy" data-gallery-img /><figcaption>${index === 0 ? "主圖" : `第 ${position} 張`}</figcaption></figure><div class="admin-gallery-actions"><button type="button" data-gallery-move="-1" aria-label="第 ${position} 張往前移" ${index === 0 ? "disabled" : ""}>←</button><button type="button" data-gallery-move="1" aria-label="第 ${position} 張往後移" ${index === total - 1 ? "disabled" : ""}>→</button><button type="button" class="admin-gallery-delete" data-gallery-delete aria-label="刪除第 ${position} 張">刪除</button></div></li>`;
}

function galleryInnerMarkup(product) {
  const images = sortedImages(product);
  const remaining = MAX_IMAGES - images.length;
  const titleId = `admin-gallery-title-${product.id}`;
  const list = images.length
    ? `<ol class="admin-gallery-list">${images.map((image, index) => galleryItemMarkup(product, image, index, images.length)).join("")}</ol>`
    : '<p class="admin-gallery-empty">尚未上傳照片。</p>';
  const note = product.is_published ? "" : "未上架商品的既有照片需上架後才能預覽；本次上傳的照片可直接預覽。";
  return `<header><h4 id="${titleId}">商品照片 <span>${images.length} / ${MAX_IMAGES}</span></h4><p>第 1 張為主圖，會顯示在商品卡與首頁輪播。${note}</p></header>${list}<div class="admin-gallery-upload"><label class="admin-gallery-picker${remaining ? "" : " is-disabled"}">${remaining ? "選擇照片（可多選）" : "已達 10 張上限"}<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-gallery-input ${remaining ? "" : "disabled"} /></label><small>剩餘 ${remaining} 張名額；JPG、PNG、WebP，單張 5MB 內，會自動縮放並轉成 WebP。</small><p class="admin-gallery-status" data-gallery-status role="status" aria-live="polite"></p></div>`;
}

export function adminProductGalleryMarkup(product) {
  return `<section class="admin-gallery" data-gallery-product="${escapeHtml(product.id)}" aria-labelledby="admin-gallery-title-${escapeHtml(product.id)}">${galleryInnerMarkup(product)}</section>`;
}

export function adminProductShowcaseMarkup(product) {
  const details = product.details || "";
  const rankOptions = Array.from({ length: HERO_RANK_MAX }, (_, index) => index + 1)
    .map((rank) => `<option value="${rank}" ${Number(product.hero_rank) === rank ? "selected" : ""}>第 ${rank} 位</option>`).join("");
  return `<form class="admin-form admin-showcase-form" data-showcase-form="${escapeHtml(product.id)}"><h4>商品頁與首頁輪播</h4><label class="admin-showcase-details">商品詳細介紹<textarea name="details" rows="8" maxlength="${DETAILS_MAX}" placeholder="團隊：…&#10;作品：…&#10;尺寸：…&#10;&#10;・預購須知一&#10;・預購須知二">${escapeHtml(details)}</textarea><small>每行「名稱：內容」會顯示成規格表；「・」或「-」開頭為清單；空一行分段。<span data-showcase-count>${details.length}</span> / ${DETAILS_MAX}</small></label><div class="form-grid"><label>首頁輪播排序<select name="hero_rank"><option value="">不上輪播</option>${rankOptions}</select><small>需有照片且有可售規格才會出現；全部未設定時，首頁自動輪播最新的預購商品。</small></label><label>輪播導購文<input name="hero_tagline" maxlength="${TAGLINE_MAX}" value="${escapeHtml(product.hero_tagline || "")}" placeholder="一句話介紹亮點" /><small>${TAGLINE_MAX} 字內。首頁輪播只顯示圖片，導購文會作為圖片的無障礙說明。</small></label></div><button class="primary-button" type="submit">儲存展示設定</button></form>`;
}

function productFor(section) {
  return deps.getProduct(section?.dataset.galleryProduct);
}

function rerender(section, product) {
  const status = section.querySelector("[data-gallery-status]");
  const message = status?.textContent || "";
  const kind = status?.dataset.kind || "";
  section.innerHTML = galleryInnerMarkup(product);
  const nextStatus = section.querySelector("[data-gallery-status]");
  if (nextStatus && message) { nextStatus.textContent = message; nextStatus.dataset.kind = kind; }
  updateCardThumbnail(section, product);
}

// 卡片標題的縮圖永遠跟著第 1 張走，避免重新載入整個商品清單（會收合正在編輯的區塊）。
function updateCardThumbnail(section, product) {
  const thumbnail = section.closest(".admin-product-card")?.querySelector(".admin-product-thumbnail");
  if (!thumbnail) return;
  const primary = sortedImages(product)[0];
  delete thumbnail.dataset.imageFallbackApplied;
  thumbnail.innerHTML = primary
    ? `<img src="${escapeHtml(imageUrl(product.id, primary))}" alt="${escapeHtml(product.name)}" loading="lazy" />`
    : deps.fallbackMarkup();
}

function setStatus(section, message, kind = "") {
  const status = section.querySelector("[data-gallery-status]");
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function setBusy(section, busy) {
  section.dataset.busy = busy ? "true" : "false";
  section.querySelectorAll("button, input").forEach((control) => {
    if (busy) { control.dataset.wasDisabled = control.disabled ? "true" : "false"; control.disabled = true; }
    else if (control.dataset.wasDisabled === "false") control.disabled = false;
  });
}

async function runExclusive(section, task) {
  const productId = section.dataset.galleryProduct;
  if (busyProducts.has(productId)) return;
  busyProducts.add(productId);
  setBusy(section, true);
  try { await task(); }
  finally {
    busyProducts.delete(productId);
    const current = document.querySelector(`[data-gallery-product="${CSS.escape(productId)}"]`);
    if (current) setBusy(current, false);
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(section, input) {
  const product = productFor(section);
  const selected = [...(input.files || [])];
  input.value = "";
  if (!product || !selected.length) return;
  const remaining = MAX_IMAGES - sortedImages(product).length;
  const files = selected.slice(0, Math.max(remaining, 0));
  const skipped = selected.length - files.length;
  if (!files.length) return setStatus(section, "已達 10 張上限，請先刪除照片再上傳。", "error");
  const failures = [];
  let uploaded = 0;
  for (const [index, file] of files.entries()) {
    setStatus(section, `處理並上傳第 ${index + 1} / ${files.length} 張：${file.name}`);
    try {
      const prepared = await deps.prepareProductImage(file);
      const formData = new FormData();
      formData.append("image", prepared.file, prepared.file.name);
      if (prepared.width) formData.append("width", String(prepared.width));
      if (prepared.height) formData.append("height", String(prepared.height));
      const result = await deps.adminFetch(`/api/admin/products/${product.id}/images`, { method: "POST", body: formData });
      const preview = await readAsDataUrl(prepared.file);
      if (preview) localPreviews.set(result.image.id, preview);
      product.product_images = [...sortedImages(product), { id: result.image.id, sort_order: sortedImages(product).length, updated_at: new Date().toISOString(), width: result.image.width, height: result.image.height }];
      uploaded += 1;
    } catch (error) {
      failures.push(`${file.name}：${error.message || "上傳失敗"}`);
      // 上限等伺服器端拒絕代表後續檔案也不會成功，直接停止。
      if (error.status === 400 && /最多 10 張/.test(error.message || "")) break;
    }
  }
  const parts = [`已上傳 ${uploaded} 張`];
  if (skipped) parts.push(`超過上限未上傳 ${skipped} 張`);
  if (failures.length) parts.push(`失敗 ${failures.length} 張（${failures.join("；")}）`);
  const kind = failures.length || skipped ? (uploaded ? "warning" : "error") : "success";
  setStatus(section, parts.join("，"), kind);
  rerender(section, product);
  deps.showToast(parts.join("，"), kind);
}

async function moveImage(section, imageId, direction) {
  const product = productFor(section);
  const images = sortedImages(product);
  const from = images.findIndex((image) => image.id === imageId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= images.length) return;
  const reordered = [...images];
  [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
  try {
    await deps.adminFetch(`/api/admin/products/${product.id}/images/order`, { method: "PATCH", body: JSON.stringify({ image_ids: reordered.map((image) => image.id) }) });
    product.product_images = reordered.map((image, index) => ({ ...image, sort_order: index }));
    setStatus(section, to === 0 || from === 0 ? "排序已更新，主圖已變更" : "排序已更新", "success");
    rerender(section, product);
  } catch (error) {
    setStatus(section, error.message || "排序失敗", "error");
    deps.showToast(error.message || "排序失敗", "error");
  }
}

async function deleteImage(section, imageId) {
  const product = productFor(section);
  const images = sortedImages(product);
  const index = images.findIndex((image) => image.id === imageId);
  if (index < 0) return;
  try {
    await deps.adminFetch(`/api/admin/products/${product.id}/images/${imageId}`, { method: "DELETE" });
    localPreviews.delete(imageId);
    product.product_images = images.filter((image) => image.id !== imageId).map((image, position) => ({ ...image, sort_order: position }));
    setStatus(section, index === 0 && product.product_images.length ? "已刪除，第 2 張成為新主圖" : "已刪除照片", "success");
    rerender(section, product);
  } catch (error) {
    setStatus(section, error.message || "刪除失敗", "error");
    deps.showToast(error.message || "刪除失敗", "error");
  }
}

async function saveShowcase(form) {
  const productId = form.dataset.showcaseForm;
  const product = deps.getProduct(productId);
  const button = form.querySelector("button[type='submit']");
  const formData = new FormData(form);
  const heroRank = String(formData.get("hero_rank") || "");
  if (button) { button.disabled = true; button.textContent = "儲存中…"; }
  try {
    const result = await deps.adminFetch(`/api/admin/products/${productId}/showcase`, { method: "PATCH", body: JSON.stringify({ details: String(formData.get("details") || ""), hero_rank: heroRank ? Number(heroRank) : null, hero_tagline: String(formData.get("hero_tagline") || "") }) });
    if (product) Object.assign(product, { details: result.details, hero_rank: result.hero_rank, hero_tagline: result.hero_tagline });
    deps.showToast("展示設定已儲存", "success");
    // 展示設定不重新載入整份商品清單（見上方 rerender 只換這個 section），編輯面板的「未儲存修改」追蹤
    // 需要另外收到成功訊號才會清除 dirty 狀態；由 admin-products-table.js 監聽這個事件。
    form.dispatchEvent(new Event("admin:showcase-saved", { bubbles: true }));
  } catch (error) {
    deps.showToast(error.message || "展示設定儲存失敗", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "儲存展示設定"; }
  }
}

function disarmDelete(button) {
  window.clearTimeout(deleteTimers.get(button));
  deleteTimers.delete(button);
  if (button.dataset.confirming !== "true") return;
  delete button.dataset.confirming;
  button.classList.remove("is-confirming");
  button.textContent = "刪除";
  button.setAttribute("aria-label", button.dataset.originalLabel || "刪除照片");
}

// 第一次按：進入確認狀態並提示；回傳 false 表示尚未確認
function confirmDelete(section, button) {
  if (button.dataset.confirming === "true") {
    disarmDelete(button);
    return true;
  }
  section.querySelectorAll("[data-gallery-delete][data-confirming]").forEach(disarmDelete);
  button.dataset.originalLabel = button.getAttribute("aria-label") || "刪除照片";
  button.dataset.confirming = "true";
  button.classList.add("is-confirming");
  button.textContent = "確定刪除？";
  button.setAttribute("aria-label", `再按一次確定${button.dataset.originalLabel}，刪除後無法復原`);
  setStatus(section, "再按一次「確定刪除？」即刪除該照片，刪除後無法復原。", "warning");
  deleteTimers.set(button, window.setTimeout(() => {
    disarmDelete(button);
    if (section.querySelector("[data-gallery-status]")?.dataset.kind === "warning") setStatus(section, "");
  }, DELETE_CONFIRM_MS));
  return false;
}

function onClick(event) {
  const moveButton = event.target.closest("[data-gallery-move]");
  const deleteButton = event.target.closest("[data-gallery-delete]");
  const button = moveButton || deleteButton;
  if (!button) return;
  const section = button.closest("[data-gallery-product]");
  const imageId = button.closest("[data-image-id]")?.dataset.imageId;
  if (!section || !imageId) return;
  if (moveButton) runExclusive(section, () => moveImage(section, imageId, Number(moveButton.dataset.galleryMove)));
  else if (confirmDelete(section, deleteButton)) runExclusive(section, () => deleteImage(section, imageId));
}

function onChange(event) {
  const input = event.target.closest?.("[data-gallery-input]");
  const section = input?.closest("[data-gallery-product]");
  if (section) runExclusive(section, () => uploadFiles(section, input));
}

function onInput(event) {
  const textarea = event.target.closest?.("[data-showcase-form] textarea[name='details']");
  const counter = textarea?.closest("label")?.querySelector("[data-showcase-count]");
  if (counter) counter.textContent = String(textarea.value.length);
}

function onSubmit(event) {
  const form = event.target.closest?.("[data-showcase-form]");
  if (!form) return;
  event.preventDefault();
  saveShowcase(form);
}

function onImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.matches("[data-gallery-img]")) return;
  image.replaceWith(Object.assign(document.createElement("span"), { className: "admin-gallery-missing", textContent: "上架後可預覽" }));
}

export function initAdminProductGallery(options) {
  if (deps) return;
  deps = options;
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("error", onImageError, true);
}
